import { createHash, randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { getSetting } from "@psyche/db";
import type { SandboxStdioProcess } from "@psyche/mcp-host";
import {
  EXEC_DEFAULT_TIMEOUT_MS,
  type ExecRequest,
  type ExecResult,
  type MethodParams,
  type NodeClient,
  PsycheError,
  type SandboxBackendKind,
  type SandboxInstance,
  type SandboxMount,
  type SandboxNetwork,
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

/** What the guest is called to the owner: the sandbox Mac (macOS host) or sandbox PC (Windows). */
const SANDBOX = process.platform === "win32" ? "sandbox PC" : "sandbox Mac";
const SANDBOX_TITLE = process.platform === "win32" ? "Sandbox PC" : "Sandbox Mac";
const FRESH = process.platform === "win32" ? "a fresh PC" : "a fresh Mac";

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
/** A stdio session lives until it is closed; the invocation timer is only a backstop (~24 days). */
const SESSION_INVOKE_MS = 2_147_000_000;
/** What the guest node declares when it can run the srt features (stdin, staging, sessions). */
export const GUEST_SESSION_CAPABILITY = "exec.session.open";

/** A file staged into the guest's workspace before a run or session starts. */
export interface VmFile {
  /** Relative, `/`-separated. */
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

/**
 * One isolated run in the guest (`run_script`): a fresh folder removed afterwards, the files
 * staged first, text on stdin, and no network unless `network: "allow"` (then the guest's own,
 * which is none unless the owner turned the guest's network on).
 */
export interface VmRunRequest {
  argv: string[];
  stdin?: string;
  files?: VmFile[];
  network: "none" | "allow";
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Default `{kind: "thread", id: "scripts"}`; each run gets its own throwaway folder in it. */
  scope?: SandboxScope;
}

/** `openStdio` options: a long-lived process with raw pipes, off the network by default. */
export interface VmStdioOptions {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  files?: VmFile[];
  network?: "none" | "allow";
}

/** Adds a host folder as a guest share (the helper's `vm.share_add`); returns the guest path. */
export type VmShareFolder = (mount: SandboxMount) => Promise<string>;

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
  readonly #share: VmShareFolder | undefined;
  readonly #instances = new Map<string, SandboxInstance>();
  /** Commands running in the guest now; a restore or reset waits for none. */
  #running = 0;
  /** Open stdio sessions (MCP servers), closed on `closeAll`. */
  readonly #sessions = new Map<string, { kill(signal?: "TERM" | "KILL"): Promise<void> }>();

  constructor(
    services: ComposeServices,
    gateway: () => Gateway | null,
    guestPhase: () => VmGuest["phase"] | null | undefined,
    /** L6: resets the guest once for this Task when `vm.resetPerTask` is on. */
    resetForTask?: (taskId: string) => Promise<void>,
    /** Shares a granted host folder with the guest (the helper's `vm.share_add`). */
    share?: VmShareFolder,
  ) {
    this.#services = services;
    this.#gateway = gateway;
    this.#guestPhase = guestPhase;
    this.#resetForTask = resetForTask;
    this.#share = share;
  }

  /**
   * Whether the guest can run the srt features now: VM mode on, the guest running and its
   * psyche-node connected with stdin, staging and sessions (`exec.session.open`).
   */
  canIsolate(): boolean {
    const phase = this.#guestPhase();
    if (phase !== undefined && phase !== null && phase !== "running") return false;
    return this.#guest(GUEST_SESSION_CAPABILITY) !== undefined;
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

  /** The guest node's client when VM mode is on and it is connected with `capability`. */
  #guest(capability = "exec"): NodeClient | undefined {
    const s = settingsOf(this.#services);
    const nodes = this.#gateway()?.context.nodes;
    if (!s.enabled || s.guestNodeId === null || nodes === undefined) return undefined;
    const info = nodes.list().find((n) => n.id === s.guestNodeId);
    if (info === undefined || !nodes.isLive(info.id)) return undefined;
    // The sandbox guest arrives through the Host helper's relay, on the guest socket: a node on
    // any other transport (a WebSocket node that declares `vm-guest`) is never the guest.
    if (nodes.transportOf(info.id) !== "vm-relay") return undefined;
    if (!info.capabilities.some((c) => c.name === "exec")) return undefined;
    if (!info.capabilities.some((c) => c.name === capability)) return undefined;
    return nodes.client(info.id);
  }

  #require(capability = "exec"): NodeClient {
    const s = settingsOf(this.#services);
    if (!s.enabled) throw vmDisabled();
    // The helper reports the guest; while it is not running nothing reaches it.
    const phase = this.#guestPhase();
    if (phase !== undefined && phase !== null && phase !== "running") {
      throw new PsycheError("unavailable", `the ${SANDBOX} is ${phase}`, {
        details: { reason: "vm_not_running", phase },
      });
    }
    const guest = this.#guest();
    if (guest === undefined) {
      throw new PsycheError("unavailable", `the ${SANDBOX}'s psyche-node is not connected`, {
        details: { reason: "vm_guest_offline" },
      });
    }
    if (capability !== "exec" && this.#guest(capability) === undefined) {
      throw new PsycheError(
        "unavailable",
        `the ${SANDBOX}'s psyche-node is too old to run this; update Psyche in the ${SANDBOX}`,
        { details: { reason: "vm_guest_outdated", capability } },
      );
    }
    return guest;
  }

  async backends(): Promise<SandboxBackendKind[]> {
    return this.#guest() === undefined ? [] : ["vm"];
  }

  async ensureSandbox(
    scope: SandboxScope,
    options: { network?: SandboxNetwork; mounts?: SandboxMount[] } = {},
  ): Promise<SandboxInstance> {
    const id = `vm:${scope.kind}:${scope.id}`;
    if (!settingsOf(this.#services).enabled) throw vmDisabled();
    // A fresh Mac per Task: never a first command on an unreset guest; a failed reset fails it.
    if (!this.#instances.has(id) && scope.kind === "task") await this.#resetForTask?.(scope.id);
    this.#require();
    const wanted = options.mounts ?? [];
    let instance = this.#instances.get(id);
    if (instance !== undefined && wanted.length > 0) {
      const have = (instance.mounts ?? []).map((m) => `${m.source}|${m.readOnly}`).sort();
      const want = wanted.map((m) => `${m.source}|${m.readOnly}`).sort();
      if (JSON.stringify(have) !== JSON.stringify(want)) {
        throw new PsycheError(
          "conflict",
          "this sandbox exists with other folders; destroy it first",
        );
      }
    }
    if (instance === undefined) {
      // Granted folders become guest shares (Plan9 on the sandbox PC), read-only unless the
      // grant is read-write; the helper refuses sensitive roots and asks before read-write.
      const mounts: SandboxMount[] = [];
      for (const m of wanted) {
        if (this.#share === undefined) {
          throw new PsycheError("unavailable", `the ${SANDBOX} cannot share folders here`, {
            details: { reason: "vm_no_shares" },
          });
        }
        mounts.push({ source: m.source, target: await this.#share(m), readOnly: m.readOnly });
      }
      instance = {
        id,
        scope: { ...scope },
        backend: "vm",
        network: "none",
        workspacePath: "/workspace",
        status: "ready",
        ...(mounts.length === 0 ? {} : { mounts }),
      };
      this.#instances.set(id, instance);
    }
    return {
      ...instance,
      scope: { ...instance.scope },
      ...(instance.mounts === undefined ? {} : { mounts: instance.mounts.map((m) => ({ ...m })) }),
    };
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    const instance = this.#instances.get(request.sandboxId);
    if (instance === undefined) throw new PsycheError("not_found", "unknown sandbox");
    return this.#exec(instance, request, {});
  }

  /**
   * One run with the srt policy mapped onto the guest (`VmRunRequest`): what `run_script` uses
   * on Windows. The guest refuses a `network: "none"` run it cannot keep off its network.
   */
  async run(request: VmRunRequest): Promise<ExecResult> {
    if (request.argv.length === 0) throw new PsycheError("invalid_params", "empty argv");
    this.#require(GUEST_SESSION_CAPABILITY);
    const instance = await this.ensureSandbox(request.scope ?? { kind: "thread", id: "scripts" });
    return this.#exec(
      instance,
      {
        sandboxId: instance.id,
        argv: request.argv,
        cwd: "/workspace",
        timeoutMs: request.timeoutMs,
        ...(request.env === undefined ? {} : { env: request.env }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
      {
        network: request.network,
        ephemeral: true,
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        ...(request.files === undefined ? {} : { files: request.files }),
      },
    );
  }

  /**
   * A long-lived process in the guest with raw pipes (stdio MCP servers, `SandboxStdioHost`):
   * stdout and stderr stream back as the guest node's events, stdin goes as ordered writes.
   * Off the network unless `network: "allow"`. Killing it, or the guest going away, ends it.
   */
  async openStdio(sandboxId: string, options: VmStdioOptions): Promise<SandboxStdioProcess> {
    const instance = this.#instances.get(sandboxId);
    if (instance === undefined) throw new PsycheError("not_found", "unknown sandbox");
    if (options.argv.length === 0) throw new PsycheError("invalid_params", "empty argv");
    const guest = this.#require(GUEST_SESSION_CAPABILITY);
    const sessionId = `s${randomUUID().replace(/-/g, "")}`;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let started: (() => void) | undefined;
    const isStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let ended = false;
    const done = guest.invoke(
      "exec.session.open",
      {
        sessionId,
        argv: options.argv,
        cwd: options.cwd ?? "/workspace",
        scope: instance.scope,
        network: options.network ?? "none",
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.files === undefined ? {} : { files: options.files }),
      },
      {
        timeoutMs: SESSION_INVOKE_MS,
        onEvent: ({ data }) => {
          const e = (data ?? {}) as { phase?: unknown; stream?: unknown; data?: unknown };
          if (e.phase === "started") started?.();
          if (typeof e.data !== "string") return;
          // Only the documented streams cross; the guest is another machine.
          if (e.stream === "stdout") stdout.write(Buffer.from(e.data, "base64"));
          else if (e.stream === "stderr") stderr.write(Buffer.from(e.data, "base64"));
        },
      },
    );
    const finished = done.then(async (res) => {
      ended = true;
      this.#sessions.delete(sessionId);
      stdout.end();
      stderr.end();
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
      return res;
    });
    const first = await Promise.race([isStarted.then(() => null), finished]);
    if (first !== null) {
      const e = first.error;
      throw new PsycheError(
        e?.code ?? "internal",
        e?.message ?? `the ${SANDBOX} did not start it`,
        {
          details: { reason: "vm_session_failed" },
        },
      );
    }
    const exited = finished.then((res) => {
      const r = (res.ok ? res.result : undefined) as
        | { exitCode?: unknown; signal?: unknown }
        | undefined;
      return {
        exitCode: typeof r?.exitCode === "number" ? r.exitCode : null,
        signal: (typeof r?.signal === "string" ? r.signal : null) as NodeJS.Signals | null,
      };
    });
    const control = (capability: string, params: object) =>
      guest.invoke(capability, { sessionId, ...params }, { timeoutMs: 30_000 });
    let killing: Promise<void> | undefined;
    const kill = (signal: "TERM" | "KILL" = "TERM"): Promise<void> => {
      if (ended) return Promise.resolve();
      if (signal === "TERM" && killing !== undefined) return killing;
      const k = control("exec.session.close", { signal }).then(() => undefined);
      if (signal === "TERM") killing = k;
      return k;
    };
    const stdin = new Writable({
      // One write at a time, in order: each is acknowledged by the guest before the next.
      write(chunk: Buffer, _encoding, callback) {
        if (ended) return callback(new Error("the process has exited"));
        control("exec.session.write", { data: Buffer.from(chunk).toString("base64") }).then(
          (r) => callback(r.ok ? null : new Error(r.error?.message ?? "write failed")),
          (err: unknown) => callback(err instanceof Error ? err : new Error(String(err))),
        );
      },
      final(callback) {
        if (ended) return callback();
        control("exec.session.write", { end: true }).then(
          () => callback(),
          () => callback(),
        );
      },
    });
    this.#sessions.set(sessionId, { kill });
    return { stdin, stdout, stderr, exited, kill };
  }

  /** Stops every open stdio session (the Gateway is stopping). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => s.kill("KILL").catch(() => {})));
  }

  async #exec(
    instance: SandboxInstance,
    request: ExecRequest,
    extras: Pick<VmRunRequest, "stdin" | "files"> & {
      network?: VmRunRequest["network"];
      ephemeral?: boolean;
    },
  ): Promise<ExecResult> {
    if (request.argv.length === 0) throw new PsycheError("invalid_params", "empty argv");
    if (request.signal?.aborted === true) throw new PsycheError("cancelled", "exec cancelled");
    const guest = this.#require(Object.keys(extras).length > 0 ? GUEST_SESSION_CAPABILITY : "exec");
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
          ...extras,
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
      throw new PsycheError(e?.code ?? "internal", e?.message ?? `exec in the ${SANDBOX} failed`, {
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
    (mount) => shareFolder(mount),
  );

  /**
   * A granted host folder as a guest share (`vm.share_add`, Plan9 on the sandbox PC): read-only
   * unless the mount is read-write, which the helper refuses without the owner's approval. One
   * share per folder, reused while the guest has it. Adding one restarts the guest's psyche-node.
   */
  const shareFolder = async (mount: SandboxMount): Promise<string> => {
    const { helper, name } = target("vm.share_add");
    const share = `psyche-${createHash("sha256").update(mount.source, "utf8").digest("hex").slice(0, 12)}`;
    const find = () => {
      for (const byName of guests.values()) {
        const s = byName.get(name)?.shares.find((x) => x.name === share);
        if (s !== undefined) return s;
      }
      return undefined;
    };
    const have = find();
    if (have !== undefined && have.readOnly === mount.readOnly) return have.guestPath;
    if (have !== undefined) await invoke(helper, "vm.share_remove", { name, share });
    const after = await invoke<VmGuest>(helper, "vm.share_add", {
      name,
      share,
      path: mount.source,
      readOnly: mount.readOnly,
    });
    await refresh();
    const added = after?.shares?.find((x) => x.name === share) ?? find();
    if (added === undefined) {
      throw new PsycheError("internal", `the ${SANDBOX} did not report the new share`, {
        details: { reason: "vm_share_missing" },
      });
    }
    return added.guestPath;
  };

  // The sandbox Mac belongs to the Host: only its own helper reports and controls it
  // (`NodeRegistry.hostHelper`), never a second Mac that paired as a node.
  const helpers = (): NodeClient[] => {
    const helper = gateway?.context.nodes.hostHelper("vm.status");
    return helper === undefined ? [] : [helper.client];
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
            summary: `${SANDBOX_TITLE} ${guest.name}: ${prev?.phase ?? "found"} → ${guest.phase}`,
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
          summary: `${SANDBOX_TITLE} ${name}: ${prev.phase} → deleted`,
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
      // Only the Host's own helper controls the sandbox Mac (a guest report from any other node
      // is ignored), and only while it is the sole Host helper.
      if (!nodes.isHostHelper(nodeId) || nodes.hostHelper()?.info.id !== nodeId) continue;
      const info = nodes.list().find((n) => n.id === nodeId);
      if (info?.capabilities.some((c) => c.name === capability) !== true) continue;
      const helper = nodes.client(nodeId);
      if (helper !== undefined) return { helper, name: guest.name };
    }
    throw new PsycheError("unavailable", `no helper with the ${SANDBOX} is connected`, {
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
        throw new PsycheError("timeout", `the ${SANDBOX} did not come back`, {
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
      throw new PsycheError("conflict", `a command is running in the ${SANDBOX}`, {
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
            throw new PsycheError("conflict", `another Task is using the ${SANDBOX}`, {
              details: { reason: "vm_in_use", taskId: id },
            });
          }
        }
        await audited(
          "task_reset",
          `Reset the ${SANDBOX} for a new Task`,
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
          kind === "base" ? `Saved the ${SANDBOX}'s reset point` : `Snapshotted the ${SANDBOX}`,
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
          `Restored the ${SANDBOX} to a snapshot`,
          { snapshot: params.snapshot },
          () => rewind("vm.restore", params.snapshot, false),
        );
      },
    },
    "vm.snapshots.reset": {
      run: () => {
        target("vm.reset");
        return audited("reset", `Reset the ${SANDBOX} to ${FRESH}`, {}, () =>
          rewind("vm.reset", undefined, false),
        );
      },
    },
    "vm.snapshots.delete": {
      run: (_call: Call, params: MethodParams<"vm.snapshots.delete">) => {
        const { helper, name } = target("vm.snapshot_delete");
        return audited(
          "delete",
          `Deleted a ${SANDBOX} snapshot`,
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
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await runner.closeAll();
    },
  };
}
