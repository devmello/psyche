import { getSetting } from "@psyche/db";
import {
  EXEC_DEFAULT_TIMEOUT_MS,
  type ExecRequest,
  type ExecResult,
  type MethodParams,
  type NodeClient,
  PsycheError,
  type SandboxBackendKind,
  type SandboxInstance,
  type SandboxRunner,
  type SandboxScope,
  type TaskWorkspace,
  VM_SETTING_KEYS,
  type VmGuest,
  type VmRestoreResult,
  type VmSnapshotResult,
  type VmStatus,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import type { Gateway } from "../server.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * VM mode, Gateway side (features L1–L5; architecture §10; security §13). The mac helper owns
 * the sandbox Mac (`vm.*` node capabilities); the guest's psyche-node pairs with this Gateway
 * through the helper's vsock relay. This part:
 *
 * - offers a `vm` `SandboxRunner` whose commands run in the guest, through the guest node's
 *   `exec` capability, for Tasks whose workspace is `vm`. There is no fallback to the host's
 *   container (or the reverse): a Task that asked for the guest fails while the guest is off;
 * - follows the helper's `vm.status` and publishes `vm.updated` for each guest that changed,
 *   with a `vm.lifecycle` receipt (audited) for every phase change;
 * - reads the owner's settings (`VM_SETTING_KEYS`, admin-only) on every decision, so changes
 *   apply without a restart;
 * - serves the owner's `vm.snapshots.*` (L6) over the helper's `vm.snapshot` / `vm.restore` /
 *   `vm.reset` / `vm.snapshot_delete`, each audited as a `vm.snapshot` receipt, and with
 *   `vm.resetPerTask` on resets the guest once before a `vm` Task's first command. The agent gets
 *   no snapshot or reset tool: changing the guest is the owner's (security §13).
 */

export interface VmSetup {
  /** `vm.status` poll interval while every guest is settled. Default 30 s; 0 disables. */
  pollMs?: number;
  /** Poll interval while a guest is installing, provisioning, starting or stopping. Default 3 s. */
  busyPollMs?: number;
  /** How long a reset waits for the guest's psyche-node to come back. Default 3 min. */
  guestReadyTimeoutMs?: number;
}

export interface ResolvedVmSettings {
  enabled: boolean;
  guestNodeId: string | null;
  defaultWorkspace: TaskWorkspace;
  resetPerTask: boolean;
}

export interface ComposedVm extends ComposedPart {
  readonly runner: VmRunner;
  settings(): ResolvedVmSettings;
  /** Where a call's commands run: its Task's workspace, else the owner's default. */
  workspaceFor(ctx: { taskId?: string }): TaskWorkspace;
  /** Polls the helper once now (tests, and after a `vm.*` change). */
  refresh(): Promise<void>;
}

/** Phases a restore or reset first stops (the helper refuses an active guest). */
const UP: ReadonlySet<VmGuest["phase"]> = new Set(["running", "starting", "paused"]);
const TERMINAL = new Set(["done", "failed", "cancelled"]);
/** Snapshots, restores, starts and stops can take minutes on a large disk. */
const HELPER_TIMEOUT_MS = 10 * 60_000;

const BUSY: ReadonlySet<VmGuest["phase"]> = new Set([
  "installing",
  "provisioning",
  "starting",
  "stopping",
]);
/** Grace on top of the command's own timeout for the node round trip. */
const INVOKE_GRACE_MS = 15_000;

function settingsOf(services: ComposeServices): ResolvedVmSettings {
  const value = (key: string) => getSetting(services.db, key)?.value;
  const guest = value(VM_SETTING_KEYS.guestNodeId);
  const workspace = value(VM_SETTING_KEYS.defaultWorkspace);
  return {
    enabled: value(VM_SETTING_KEYS.enabled) === true,
    guestNodeId: typeof guest === "string" && guest !== "" ? guest : null,
    defaultWorkspace: workspace === "vm" ? "vm" : "sandbox",
    resetPerTask: value(VM_SETTING_KEYS.resetPerTask) === true,
  };
}

function vmDisabled(): PsycheError {
  return new PsycheError("unavailable", "VM mode is off", { details: { reason: "vm_disabled" } });
}

/** What a lifecycle receipt and `vm.updated` compare: everything the owner sees about a guest. */
const fingerprint = (g: VmGuest) => JSON.stringify(g);

/**
 * The guest as a `SandboxRunner`. One "sandbox" per scope, all in the one guest: its psyche-node
 * keeps a workspace per scope. The guest's own policy applies inside it (NAT network, explicit
 * shares only, security §13); `network` on the instance describes the host side, which it never
 * touches.
 */
export class VmRunner implements SandboxRunner {
  readonly #services: ComposeServices;
  readonly #gateway: () => Gateway | null;
  readonly #guestPhase: () => VmGuest["phase"] | null | undefined;
  readonly #resetForTask: ((taskId: string) => Promise<void>) | undefined;
  readonly #instances = new Map<string, SandboxInstance>();
  /** Commands running in the guest now; a restore or reset waits for none. */
  #running = 0;

  constructor(
    services: ComposeServices,
    gateway: () => Gateway | null,
    guestPhase: () => VmGuest["phase"] | null | undefined,
    /** L6: resets the guest once for this Task when `vm.resetPerTask` is on. */
    resetForTask?: (taskId: string) => Promise<void>,
  ) {
    this.#services = services;
    this.#gateway = gateway;
    this.#guestPhase = guestPhase;
    this.#resetForTask = resetForTask;
  }

  /** Whether a command is running in the guest. */
  get busy(): boolean {
    return this.#running > 0;
  }

  /** Whether the guest's psyche-node is connected with `exec` (VM mode on). */
  ready(): boolean {
    return this.#guest() !== undefined;
  }

  /** Tasks with a workspace in the guest. */
  taskIds(): string[] {
    return [...this.#instances.values()]
      .filter((i) => i.scope.kind === "task")
      .map((i) => i.scope.id);
  }

  /** The guest node's client when VM mode is on and it is connected with `exec`. */
  #guest(): NodeClient | undefined {
    const s = settingsOf(this.#services);
    const nodes = this.#gateway()?.context.nodes;
    if (!s.enabled || s.guestNodeId === null || nodes === undefined) return undefined;
    const info = nodes.list().find((n) => n.id === s.guestNodeId);
    if (info === undefined || !nodes.isLive(info.id)) return undefined;
    if (!info.capabilities.some((c) => c.name === "exec")) return undefined;
    return nodes.client(info.id);
  }

  #require(): NodeClient {
    const s = settingsOf(this.#services);
    if (!s.enabled) throw vmDisabled();
    // The helper reports the guest; while it is not running nothing reaches it.
    const phase = this.#guestPhase();
    if (phase !== undefined && phase !== null && phase !== "running") {
      throw new PsycheError("unavailable", `the sandbox Mac is ${phase}`, {
        details: { reason: "vm_not_running", phase },
      });
    }
    const guest = this.#guest();
    if (guest === undefined) {
      throw new PsycheError("unavailable", "the sandbox Mac's psyche-node is not connected", {
        details: { reason: "vm_guest_offline" },
      });
    }
    return guest;
  }

  async backends(): Promise<SandboxBackendKind[]> {
    return this.#guest() === undefined ? [] : ["vm"];
  }

  async ensureSandbox(scope: SandboxScope): Promise<SandboxInstance> {
    const id = `vm:${scope.kind}:${scope.id}`;
    if (!settingsOf(this.#services).enabled) throw vmDisabled();
    // A fresh Mac per Task: never a first command on an unreset guest; a failed reset fails it.
    if (!this.#instances.has(id) && scope.kind === "task") await this.#resetForTask?.(scope.id);
    this.#require();
    let instance = this.#instances.get(id);
    if (instance === undefined) {
      instance = {
        id,
        scope: { ...scope },
        backend: "vm",
        network: "none",
        workspacePath: "/workspace",
        status: "ready",
      };
      this.#instances.set(id, instance);
    }
    return { ...instance, scope: { ...instance.scope } };
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    const instance = this.#instances.get(request.sandboxId);
    if (instance === undefined) throw new PsycheError("not_found", "unknown sandbox");
    if (request.argv.length === 0) throw new PsycheError("invalid_params", "empty argv");
    if (request.signal?.aborted === true) throw new PsycheError("cancelled", "exec cancelled");
    const guest = this.#require();
    const timeoutMs = request.timeoutMs || EXEC_DEFAULT_TIMEOUT_MS;
    this.#running += 1;
    const res = await guest
      .invoke(
        "exec",
        {
          argv: request.argv,
          cwd: request.cwd,
          ...(request.env === undefined ? {} : { env: request.env }),
          timeoutMs,
          scope: instance.scope,
        },
        {
          timeoutMs: timeoutMs + INVOKE_GRACE_MS,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      )
      .finally(() => {
        this.#running -= 1;
      });
    if (res.receipt !== undefined) {
      await this.#services.broker
        .recordReceipt({
          kind: "vm.exec",
          outcome: res.receipt.outcome,
          summary: res.receipt.summary,
          ...(instance.scope.kind === "task" ? { taskId: instance.scope.id } : {}),
        })
        .catch(() => undefined);
    }
    if (!res.ok) {
      const e = res.error;
      throw new PsycheError(e?.code ?? "internal", e?.message ?? "exec in the sandbox Mac failed", {
        details: { reason: "vm_exec_failed" },
      });
    }
    const r = res.result as Partial<ExecResult> | undefined;
    // Only the documented shape crosses: the guest is another machine.
    return {
      exitCode: typeof r?.exitCode === "number" ? r.exitCode : null,
      stdout: typeof r?.stdout === "string" ? r.stdout : "",
      stderr: typeof r?.stderr === "string" ? r.stderr : "",
      durationMs: typeof r?.durationMs === "number" ? r.durationMs : 0,
      truncated: r?.truncated === true,
      filesChanged: Array.isArray(r?.filesChanged)
        ? r.filesChanged.filter((f): f is string => typeof f === "string")
        : [],
      timedOut: r?.timedOut === true,
      outcome: r?.outcome === "ok" || r?.outcome === "failed" ? r.outcome : "uncertain",
      // Whatever ran in the guest read and wrote the guest's files: never trusted on return.
      provenance: "untrusted",
    };
  }

  async destroy(sandboxId: string): Promise<void> {
    this.#instances.delete(sandboxId);
  }
}

export function composeVm(services: ComposeServices, setup: VmSetup = {}): ComposedVm {
  let gateway: Gateway | null = null;
  const guests = new Map<string, Map<string, VmGuest>>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  /** The guest the owner's VM mode uses: the helper's (single) guest, when one reports. */
  const guestPhase = (): VmGuest["phase"] | null | undefined => {
    for (const byName of guests.values()) for (const g of byName.values()) return g.phase;
    return undefined;
  };
  const runner = new VmRunner(
    services,
    () => gateway,
    guestPhase,
    (taskId) => resetForTask(taskId),
  );

  const helpers = (): NodeClient[] => {
    const nodes = gateway?.context.nodes;
    if (nodes === undefined) return [];
    return nodes
      .list()
      .filter((n) => nodes.isLive(n.id) && n.capabilities.some((c) => c.name === "vm.status"))
      .flatMap((n) => {
        const c = nodes.client(n.id);
        return c === undefined ? [] : [c];
      });
  };

  const observe = async (nodeId: string, status: VmStatus) => {
    const before = guests.get(nodeId) ?? new Map<string, VmGuest>();
    const after = new Map(status.guests.map((g) => [g.name, g]));
    guests.set(nodeId, after);
    const at = new Date(services.clock.now()).toISOString();
    for (const guest of after.values()) {
      const prev = before.get(guest.name);
      if (prev !== undefined && fingerprint(prev) === fingerprint(guest)) continue;
      services.publish("vm.updated", { nodeId, guest, at });
      // The owner's audit trail of the guest's life (created, booted, stopped, failed).
      if (prev?.phase !== guest.phase) {
        await services.broker
          .recordReceipt({
            kind: "vm.lifecycle",
            outcome: guest.phase === "failed" ? "failed" : "ok",
            summary: `Sandbox Mac ${guest.name}: ${prev?.phase ?? "found"} → ${guest.phase}`,
            payload: {
              nodeId,
              name: guest.name,
              from: prev?.phase ?? null,
              to: guest.phase,
              ...(guest.lastError === undefined ? {} : { reason: guest.lastError }),
            },
          })
          .catch(() => undefined);
      }
    }
    for (const [name, prev] of before) {
      if (after.has(name)) continue;
      await services.broker
        .recordReceipt({
          kind: "vm.lifecycle",
          outcome: "ok",
          summary: `Sandbox Mac ${name}: ${prev.phase} → deleted`,
          payload: { nodeId, name, from: prev.phase, to: "deleted" },
        })
        .catch(() => undefined);
    }
  };

  const refresh = async () => {
    for (const helper of helpers()) {
      try {
        const res = await helper.invoke("vm.status", {}, { timeoutMs: 10_000 });
        if (res.ok) await observe(helper.nodeId, res.result as VmStatus);
      } catch (err) {
        services.logger?.log("warn", "vm.status failed", { code: PsycheError.from(err).code });
      }
    }
  };

  // --- L6: snapshots and resets -------------------------------------------------------------

  /** The live helper reporting the owner's guest with `capability`, and the guest's name. */
  const target = (capability: string): { helper: NodeClient; name: string } => {
    if (!settingsOf(services).enabled) throw vmDisabled();
    const nodes = gateway?.context.nodes;
    for (const [nodeId, byName] of guests) {
      const guest = byName.values().next().value as VmGuest | undefined;
      if (guest === undefined || nodes === undefined || !nodes.isLive(nodeId)) continue;
      const info = nodes.list().find((n) => n.id === nodeId);
      if (info?.capabilities.some((c) => c.name === capability) !== true) continue;
      const helper = nodes.client(nodeId);
      if (helper !== undefined) return { helper, name: guest.name };
    }
    throw new PsycheError("unavailable", "no mac helper with the sandbox Mac is connected", {
      details: { reason: "vm_helper_unavailable", capability },
    });
  };

  const invoke = async <T>(helper: NodeClient, capability: string, params: object) => {
    const res = await helper.invoke(capability, params, { timeoutMs: HELPER_TIMEOUT_MS });
    if (!res.ok) {
      throw new PsycheError(res.error?.code ?? "internal", res.error?.message ?? capability, {
        details: { reason: "vm_helper_failed", capability },
      });
    }
    return res.result as T;
  };

  /** One change to the guest at a time: the owner's and the per-Task resets never interleave. */
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  /** Runs one change, audited as a `vm.snapshot` receipt either way, then publishes the guest. */
  const audited = <T>(
    action: string,
    summary: string,
    payload: Record<string, string | boolean>,
    fn: () => Promise<T>,
    taskId?: string,
  ): Promise<T> =>
    exclusive(async () => {
      const receipt = (outcome: "ok" | "failed", extra: Record<string, string> = {}) =>
        services.broker
          .recordReceipt({
            kind: "vm.snapshot",
            outcome,
            summary: outcome === "ok" ? summary : `${summary} (failed)`,
            payload: { action, ...payload, ...extra },
            ...(taskId === undefined ? {} : { taskId }),
          })
          .catch(() => undefined);
      try {
        const out = await fn();
        await receipt("ok");
        return out;
      } catch (err) {
        await receipt("failed", { code: PsycheError.from(err).code });
        throw err;
      } finally {
        await refresh();
      }
    });

  /** Waits until the guest runs and its psyche-node is back (it reconnects after a boot). */
  const guestReady = async () => {
    const until = services.clock.now() + (setup.guestReadyTimeoutMs ?? 180_000);
    for (;;) {
      await refresh();
      if (guestPhase() === "running" && runner.ready()) return;
      if (services.clock.now() > until) {
        throw new PsycheError("timeout", "the sandbox Mac did not come back", {
          details: { reason: "vm_guest_not_ready" },
        });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  /**
   * `vm.restore` / `vm.reset`. The helper refuses an active guest, so a running one is stopped
   * first and, with `startAfter` or when it was up, started again. Never while a command runs.
   */
  const rewind = async (
    capability: "vm.restore" | "vm.reset",
    snapshot: string | undefined,
    startAfter: boolean,
  ): Promise<VmRestoreResult> => {
    const { helper, name } = target(capability);
    if (runner.busy) {
      throw new PsycheError("conflict", "a command is running in the sandbox Mac", {
        details: { reason: "vm_busy" },
      });
    }
    const phase = guestPhase();
    const wasUp = phase !== undefined && phase !== null && UP.has(phase);
    if (wasUp) await invoke(helper, "vm.stop", { name });
    const result = await invoke<VmRestoreResult>(
      helper,
      capability,
      snapshot === undefined ? { name } : { name, snapshot },
    );
    if (startAfter || wasUp) {
      await invoke(helper, "vm.start", { name });
      await guestReady();
    }
    return result;
  };

  /** Per-Task resets in flight or done since start; the receipts remember them across restarts. */
  const taskResets = new Map<string, Promise<void>>();
  const resetForTask = (taskId: string): Promise<void> => {
    if (!settingsOf(services).resetPerTask) return Promise.resolve();
    let pending = taskResets.get(taskId);
    if (pending === undefined) {
      pending = (async () => {
        const prior = await services.broker.listReceipts({ taskId });
        const done = prior.some(
          (r) =>
            r.kind === "vm.snapshot" && r.outcome === "ok" && r.payload?.action === "task_reset",
        );
        if (done) return;
        // A reset discards the guest's disk: never under another Task still working there.
        const others = runner.taskIds().filter((id) => id !== taskId);
        for (const id of others) {
          const row = services.db.sqlite.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as
            | { status: string }
            | undefined;
          if (row !== undefined && !TERMINAL.has(row.status)) {
            throw new PsycheError("conflict", "another Task is using the sandbox Mac", {
              details: { reason: "vm_in_use", taskId: id },
            });
          }
        }
        await audited(
          "task_reset",
          "Reset the sandbox Mac for a new Task",
          {},
          () => rewind("vm.reset", undefined, true),
          taskId,
        );
      })();
      taskResets.set(taskId, pending);
      // A failed reset is tried again by the Task's next command, never skipped.
      pending.catch(() => taskResets.delete(taskId));
    }
    return pending;
  };

  const handlers: Record<string, HandlerDef> = {
    "vm.snapshots.list": {
      run: async () => {
        const { helper, name } = target("vm.status");
        const status = await invoke<VmStatus>(helper, "vm.status", {});
        await observe(helper.nodeId, status);
        const guest = status.guests.find((g) => g.name === name);
        return { snapshots: guest?.snapshots ?? [], baseSnapshot: guest?.baseSnapshot ?? null };
      },
    },
    "vm.snapshots.create": {
      run: (_call: Call, params: MethodParams<"vm.snapshots.create">) => {
        const { helper, name } = target("vm.snapshot");
        const kind = params.base === true ? "base" : "manual";
        return audited(
          "create",
          kind === "base" ? "Saved the sandbox Mac's reset point" : "Snapshotted the sandbox Mac",
          { kind, ...(params.label === undefined ? {} : { label: params.label }) },
          () =>
            invoke<VmSnapshotResult>(helper, "vm.snapshot", {
              name,
              kind,
              ...(params.label === undefined ? {} : { label: params.label }),
            }),
        );
      },
    },
    "vm.snapshots.restore": {
      run: (_call: Call, params: MethodParams<"vm.snapshots.restore">) => {
        target("vm.restore");
        return audited(
          "restore",
          "Restored the sandbox Mac to a snapshot",
          { snapshot: params.snapshot },
          () => rewind("vm.restore", params.snapshot, false),
        );
      },
    },
    "vm.snapshots.reset": {
      run: () => {
        target("vm.reset");
        return audited("reset", "Reset the sandbox Mac to a fresh Mac", {}, () =>
          rewind("vm.reset", undefined, false),
        );
      },
    },
    "vm.snapshots.delete": {
      run: (_call: Call, params: MethodParams<"vm.snapshots.delete">) => {
        const { helper, name } = target("vm.snapshot_delete");
        return audited(
          "delete",
          "Deleted a sandbox Mac snapshot",
          { snapshot: params.snapshot },
          async () => {
            await invoke(helper, "vm.snapshot_delete", { name, snapshot: params.snapshot });
            return { deleted: true as const };
          },
        );
      },
    },
  };

  const schedule = () => {
    if (stopped) return;
    const idle = setup.pollMs ?? 30_000;
    if (idle <= 0) return;
    const busy = [...guests.values()].some((m) => [...m.values()].some((g) => BUSY.has(g.phase)));
    timer = setTimeout(
      () => {
        void refresh().finally(schedule);
      },
      busy ? (setup.busyPollMs ?? 3_000) : idle,
    );
    timer.unref?.();
  };

  return {
    runner,
    handlers,
    settings: () => settingsOf(services),
    workspaceFor(ctx) {
      if (ctx.taskId !== undefined) {
        const row = services.db.sqlite
          .prepare("SELECT workspace FROM tasks WHERE id = ?")
          .get(ctx.taskId) as { workspace: string | null } | undefined;
        if (row?.workspace === "vm" || row?.workspace === "sandbox") return row.workspace;
      }
      return settingsOf(services).defaultWorkspace;
    },
    refresh,
    async start(gw) {
      gateway = gw;
      await refresh();
      schedule();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
