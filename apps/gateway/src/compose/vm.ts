import { getSetting } from "@psyche/db";
import {
  EXEC_DEFAULT_TIMEOUT_MS,
  type ExecRequest,
  type ExecResult,
  type NodeClient,
  PsycheError,
  type SandboxBackendKind,
  type SandboxInstance,
  type SandboxRunner,
  type SandboxScope,
  type TaskWorkspace,
  VM_SETTING_KEYS,
  type VmGuest,
  type VmStatus,
} from "@psyche/protocol";
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
 *   apply without a restart.
 */

export interface VmSetup {
  /** `vm.status` poll interval while every guest is settled. Default 30 s; 0 disables. */
  pollMs?: number;
  /** Poll interval while a guest is installing, provisioning, starting or stopping. Default 3 s. */
  busyPollMs?: number;
}

export interface ResolvedVmSettings {
  enabled: boolean;
  guestNodeId: string | null;
  defaultWorkspace: TaskWorkspace;
}

export interface ComposedVm extends ComposedPart {
  readonly runner: VmRunner;
  settings(): ResolvedVmSettings;
  /** Where a call's commands run: its Task's workspace, else the owner's default. */
  workspaceFor(ctx: { taskId?: string }): TaskWorkspace;
  /** Polls the helper once now (tests, and after a `vm.*` change). */
  refresh(): Promise<void>;
}

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
  };
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
  readonly #instances = new Map<string, SandboxInstance>();

  constructor(
    services: ComposeServices,
    gateway: () => Gateway | null,
    guestPhase: () => VmGuest["phase"] | null | undefined,
  ) {
    this.#services = services;
    this.#gateway = gateway;
    this.#guestPhase = guestPhase;
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
    if (!s.enabled) {
      throw new PsycheError("unavailable", "VM mode is off", {
        details: { reason: "vm_disabled" },
      });
    }
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
    this.#require();
    const id = `vm:${scope.kind}:${scope.id}`;
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
    const res = await guest.invoke(
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
    );
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
  const runner = new VmRunner(services, () => gateway, guestPhase);

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
