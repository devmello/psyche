import { createHash, randomBytes } from "node:crypto";
import { constants as osConstants } from "node:os";
import type { Duplex } from "node:stream";
import type {
  ExecRequest,
  ExecResult,
  SandboxBackendKind,
  SandboxInstance,
  SandboxMount,
  SandboxNetwork,
  SandboxRunner,
  SandboxScope,
} from "@psyche/protocol";
import {
  CONTRACT_VERSION,
  type ContainerBackendKind,
  type ContainerState,
  execArgs,
  imageInspectArgs,
  inspectArgs,
  LABEL_PREFIX,
  parseInspect,
  type RunSpec,
  removeArgs,
  runArgs,
  startArgs,
  stopArgs,
  volumeCreateArgs,
  volumeInitArgs,
  volumeInspectArgs,
  volumeRemoveArgs,
} from "./backends.ts";
import {
  type CliDriver,
  type CliOptions,
  type CliResult,
  type CliStream,
  nodeCliDriver,
} from "./cli.ts";
import {
  type DetectedBackend,
  type DetectOptions,
  detectBackends,
  systemDetectDeps,
} from "./detect.ts";
import {
  DEFAULT_DEV_SERVER_MAX_CONNECTIONS,
  DEFAULT_DEV_SERVER_POLL_MS,
  DEFAULT_DEV_SERVER_PROBE_DELAYS_MS,
  type DevServerEvent,
  type DevServerOptions,
  type DevServerStopReason,
  PortForward,
  type ProbeResult,
  parseProbe,
  type SandboxDevServer,
} from "./devservers.ts";
import { attachTunnel, type EgressTunnel } from "./egress/tunnel.ts";
import { fail } from "./errors.ts";
import { WorkspaceFiles } from "./files.ts";
import { type ImageVariant, resolveImage } from "./image.ts";
import {
  DEFAULT_APPLE_VOLUME_SIZE,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_LIMITS,
  DEFAULT_MAX_CONCURRENT_EXECS,
  DEFAULT_MAX_PTYS,
  DEFAULT_MAX_RUNNING_APPLE,
  DEFAULT_MAX_RUNNING_SANDBOXES,
  DEFAULT_MAX_TIMEOUT_MS,
  EXEC_OUTPUT_CAP_BYTES,
  FILES_CHANGED_CAP,
  HOST_WATCHDOG_SLACK_MS,
  KILL_GRACE_MS,
  type SandboxLimits,
  WORKSPACE_PATH,
} from "./limits.ts";
import {
  MemoryProvenanceStore,
  type ProvenanceStore,
  WorkspaceProvenance,
  type WriteProvenance,
} from "./provenance.ts";
import { clampDim, createPtySession, type PtyOptions, type SandboxPty } from "./pty.ts";
import {
  BASH,
  EGRESS_SHIM,
  EXEC_WRAPPER,
  FILES_CHANGED,
  KILL_GROUP,
  LISTENERS,
  PORT_RELAY,
  PTY_RELAY,
  PYTHON,
  REAP,
  STATE_DIR,
  STDIO_RELAY,
} from "./scripts.ts";
import type { OpenStdioOptions, SandboxStdio, SandboxStdioReceipt } from "./stdio.ts";
import { Semaphore } from "./sync.ts";
import {
  mountsKey,
  validateArgv,
  validateCwd,
  validateEnv,
  validateMounts,
  validateScope,
  validateTimeout,
} from "./validate.ts";

/**
 * Opt-in egress (`network: "proxy"`, security §5.2). The proxy itself lives outside this
 * package. Its owner creates a backend network with no internet route (`docker network create
 * --internal`, `container network create --internal`) on which the proxy is reachable, and
 * hands the runner the network name and the proxy URL as seen from inside the container.
 */
export interface EgressProxyConfig {
  network: string;
  /** e.g. `http://192.168.97.2:3128`, or per scope (a per-task port or credential). */
  url: string | ((scope: SandboxScope) => string | Promise<string>);
  /** `NO_PROXY` value; default empty (everything goes through the proxy). */
  noProxy?: string;
}

/**
 * Where a proxy-mode sandbox's connections go (feature K4): `EgressProxy` from `./egress`. Each
 * connection the in-container shim accepts is handed over with the sandbox's scope.
 */
export interface EgressTunnelHandler {
  handle(scope: SandboxScope, conn: Duplex): void;
  /** The scope's workspace was deleted: forget its allowlist and decisions. */
  clear?(scope: SandboxScope): void;
}

/** Port the egress shim listens on inside the container (`HTTP_PROXY=http://127.0.0.1:3128`). */
export const EGRESS_SHIM_PORT = 3128;

export interface ContainerSandboxRunnerOptions extends DetectOptions {
  /** Image reference; default from versions.json or the local dev tag (see image.ts). */
  image?: string;
  /** Default `"base"`. */
  variant?: ImageVariant;
  /**
   * Folders never bind-mounted, besides `/`, the home folder and its ancestors and `~/Library`
   * (security §13): the Gateway passes `$PSYCHE_HOME`.
   */
  protectedMountRoots?: readonly string[];
  limits?: Partial<SandboxLimits>;
  /** Stop a container after this long without work. 0 disables. Default 10 min. */
  idleTimeoutMs?: number;
  /** Concurrent `exec` calls per scope; extra calls queue. Default 4. */
  maxConcurrentExecs?: number;
  /** Open PTYs per scope. Default 4. */
  maxPtys?: number;
  /** Long-lived stdio processes (`openStdio`) per scope. Default 8. */
  maxStdioProcesses?: number;
  /**
   * Running containers across all scopes; above it the least recently used idle one is
   * stopped. Default 3 on Apple `container` (each is a VM that keeps freed guest memory,
   * spike 02) and 8 elsewhere.
   */
  maxRunningSandboxes?: number;
  /** Largest accepted `timeoutMs`. Default 30 min. */
  maxTimeoutMs?: number;
  /**
   * What an exec may leave running after it returns (issues #290, #286). `"secrets"` (default):
   * an exec that was given a vault secret (`PSYCHE_SECRET_*`) has its whole session, and any
   * process still carrying its environment, killed when it returns, so no background child
   * keeps the secret for a later command to read. `"always"`: every exec is reaped that way
   * (one-shot work such as document conversion, where nothing may persist between inputs).
   */
  reapBackground?: "secrets" | "always";
  egressProxy?: EgressProxyConfig;
  /**
   * The egress proxy for `network: "proxy"` (feature K4), preferred over `egressProxy`: the
   * container keeps network `none` and a shim inside it carries every connection to this
   * handler over `exec -i` stdio. Works on Apple `container`, Docker and Podman alike.
   */
  egressTunnel?: EgressTunnelHandler;
  /** Prefix for container and volume names. Default `"psyche"`. */
  namePrefix?: string;
  /** Apple volumes are fixed-size ext4 images. Default `"8G"`. */
  appleVolumeSize?: string;
  driver?: CliDriver;
  /** Replaces host detection (tests). */
  detect?: () => Promise<DetectedBackend[]>;
  /**
   * Dev-server forwarding (feature I12). When set, the runner looks for TCP listeners an
   * `exec` left running in its own session, forwards each to a `127.0.0.1` port it binds on
   * the host, and reports `started` / `stopped` with that host port and the root pid. Unset
   * (the default, and on remote nodes): no probe, no forward. Callback errors are ignored.
   */
  onDevServer?: (event: DevServerEvent) => void;
  devServers?: DevServerOptions;
  /**
   * Where each scope's file provenance index lives (design-07). Default: in memory, so a
   * restart forgets it and every file reads as untrusted until it is written again. Pass a
   * `FileProvenanceStore` under `$PSYCHE_HOME` to keep it across restarts.
   */
  provenanceStore?: ProvenanceStore;
}

interface Entry {
  instance: SandboxInstance;
  backend: DetectedBackend;
  container: string;
  volume: string;
  spec: RunSpec;
  running: boolean;
  slots: Semaphore;
  active: number;
  ptys: number;
  /** Open `openStdio` processes by id; each keeps the container busy. */
  stdios: Map<string, { kill(signal?: "TERM" | "KILL"): Promise<void> }>;
  idleTimer: NodeJS.Timeout | undefined;
  starting: Promise<void> | undefined;
  lastUsed: number;
  stopping: Promise<void> | undefined;
  /** Forwarded dev servers by container port (feature I12). */
  devServers: Map<number, DevForward>;
  /** Container ports being forwarded right now (guards concurrent probes). */
  devAdopting: Set<number>;
  devPoll: NodeJS.Timeout | undefined;
  devPolling: boolean;
  devProbes: Set<NodeJS.Timeout>;
  /** `network: "proxy"` through the egress shim (K4). */
  tunnel: boolean;
  shim: { tunnel: EgressTunnel; stream: CliStream } | undefined;
  shimStarting: Promise<void> | undefined;
  /** File provenance of this scope's workspace (design-07). */
  provenance: WorkspaceProvenance;
}

interface DevForward {
  server: SandboxDevServer;
  forward: PortForward;
  /** The exec session the listener belongs to (inside the container). */
  sid: number;
}

const NO_PROBE: ProbeResult = { sid: null, alive: false, listeners: [] };

const CONFIG_LABEL = `${LABEL_PREFIX}.config`;
const DEFAULT_MAX_STDIO_PROCESSES = 8;

/** `128 + n` from the relay back to a signal name, for processes `kill` ended. */
function signalFromCode(code: number | null): NodeJS.Signals | null {
  if (code === null || code <= 128) return null;
  const n = code - 128;
  for (const [name, num] of Object.entries(osConstants.signals)) {
    if (num === n) return name as NodeJS.Signals;
  }
  return null;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function scopeKey(scope: SandboxScope): string {
  return `${scope.kind}:${scope.id}`;
}

function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(t);
      resolve(true);
    };
    p.then(done, done);
  });
}

/** Helper output is data from inside the sandbox: keep only plain workspace-relative paths. */
function plainRelative(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !path.split("/").includes("..");
}

/**
 * `SandboxRunner` over a container CLI (Apple `container`, Docker, Podman). One container per
 * scope with a persistent named `/workspace` volume, network none unless the caller opts into
 * the egress proxy, and no host-shell fallback: with no backend every call rejects.
 */
export class ContainerSandboxRunner implements SandboxRunner {
  /** File API confined to `/workspace` (K3). */
  readonly files: WorkspaceFiles;

  readonly #options: ContainerSandboxRunnerOptions;
  readonly #driver: CliDriver;
  readonly #limits: SandboxLimits;
  readonly #provenanceStore: ProvenanceStore;
  readonly #prefix: string;
  #detected: Promise<DetectedBackend[]> | undefined;
  readonly #byId = new Map<string, Entry>();
  readonly #byScope = new Map<string, Entry>();
  readonly #pending = new Map<string, Promise<Entry>>();
  readonly #appleServiceChecked = new Set<string>();
  #disposed = false;
  #tick = 0;
  /** Entries this runner believes are running or starting (for `maxRunningSandboxes`). */
  readonly #live = new Set<Entry>();
  /** Serialises container starts so the running-sandbox cap holds under concurrency. */
  readonly #startLock = new Semaphore(1);

  constructor(options: ContainerSandboxRunnerOptions = {}) {
    this.#options = options;
    this.#driver = options.driver ?? nodeCliDriver;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#prefix = options.namePrefix ?? "psyche";
    this.#provenanceStore = options.provenanceStore ?? new MemoryProvenanceStore();
    this.files = new WorkspaceFiles(
      (id, argv, opts) => this.#helper(id, argv, opts),
      (id) => this.#entry(id).provenance,
    );
  }

  /** The backend `ensureSandbox` uses, or `null` when there is none. */
  async backend(): Promise<DetectedBackend | null> {
    return (await this.#detect())[0] ?? null;
  }

  async backends(): Promise<SandboxBackendKind[]> {
    return (await this.#detect()).map((b) => b.kind);
  }

  async ensureSandbox(
    scope: SandboxScope,
    options: { network?: SandboxNetwork; mounts?: SandboxMount[] } = {},
  ): Promise<SandboxInstance> {
    validateScope(scope);
    const mounts = await validateMounts(options.mounts, this.#options.protectedMountRoots);
    const mountsDiffer = (instance: SandboxInstance) =>
      mountsKey(instance.mounts ?? []) !== mountsKey(mounts);
    const network = options.network ?? "none";
    if (network !== "none" && network !== "proxy") {
      fail("invalid_params", "network must be none or proxy");
    }
    if (this.#disposed) fail("unavailable", "sandbox runner is disposed");
    const key = scopeKey(scope);
    const existing = this.#byScope.get(key);
    if (existing) {
      if (existing.instance.network !== network) {
        fail(
          "conflict",
          `sandbox for ${key} runs with network ${existing.instance.network}; destroy it first`,
        );
      }
      if (mountsDiffer(existing.instance)) {
        fail("conflict", `sandbox for ${key} has other mounts; destroy it first`);
      }
      await this.#ensureRunning(existing);
      this.#idle(existing, false);
      return structuredClone(existing.instance);
    }
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = this.#create(scope, network, mounts).finally(() => this.#pending.delete(key));
      this.#pending.set(key, pending);
    }
    const entry = await pending;
    if (entry.instance.network !== network) {
      fail("conflict", `sandbox for ${key} runs with network ${entry.instance.network}`);
    }
    if (mountsDiffer(entry.instance)) fail("conflict", `sandbox for ${key} has other mounts`);
    return structuredClone(entry.instance);
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    validateArgv(request.argv);
    const entry = this.#byId.get(request.sandboxId);
    if (!entry) return fail("not_found", `sandbox ${request.sandboxId} not found`);
    if (request.signal?.aborted === true) fail("cancelled", "exec aborted before start");
    const cwd = validateCwd(request.cwd);
    const envPairs = validateEnv(request.env);
    const timeoutMs = validateTimeout(
      request.timeoutMs,
      this.#options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
    );
    const release = await entry.slots.acquire(request.signal);
    this.#busy(entry);
    try {
      await this.#ensureRunning(entry);
      // The signal may have fired while the slot or the container start was awaited.
      if (isAborted(request.signal)) fail("cancelled", "exec aborted before start");
      return await this.#runCommand(entry, request.argv, cwd, envPairs, timeoutMs, request.signal, {
        ...(request.provenance === undefined ? {} : { provenance: request.provenance }),
        ...(request.taintSources === undefined ? {} : { sources: request.taintSources }),
      });
    } finally {
      release();
      this.#idle(entry);
    }
  }

  /** Removes the container. The workspace volume stays; `deleteWorkspace` removes it. */
  async destroy(sandboxId: string): Promise<void> {
    const entry = this.#byId.get(sandboxId);
    if (!entry) return;
    await this.#termStdios(entry);
    this.#forget(entry);
    await this.#settle(entry);
    await this.#cli(entry.backend, removeArgs(entry.backend.kind, entry.container), {
      timeoutMs: 60_000,
    });
  }

  /** Stops the container (it restarts on the next call); files in `/workspace` persist. */
  async stop(sandboxId: string): Promise<void> {
    const entry = this.#byId.get(sandboxId);
    if (!entry) return fail("not_found", `sandbox ${sandboxId} not found`);
    await this.#stop(entry);
  }

  /** Removes the scope's container and its workspace volume. Irreversible. */
  async deleteWorkspace(scope: SandboxScope): Promise<void> {
    validateScope(scope);
    const backend = await this.#primary();
    const entry = this.#byScope.get(scopeKey(scope));
    if (entry) {
      await this.#termStdios(entry);
      this.#forget(entry);
    }
    // The files are gone, and so is what was known about them.
    await entry?.provenance.clear();
    await this.#provenanceStore.remove(scopeKey(scope));
    this.#options.egressTunnel?.clear?.(scope);
    const { container, volume } = this.#names(scope);
    await this.#cli(backend, removeArgs(backend.kind, container), { timeoutMs: 60_000 });
    const r = await this.#cli(backend, volumeRemoveArgs(backend.kind, volume), {
      timeoutMs: 60_000,
    });
    if (r.exitCode !== 0 && (await this.#volumeExists(backend, volume))) {
      fail("internal", `could not remove volume ${volume}: ${r.stderr.toString("utf8").trim()}`);
    }
  }

  /**
   * Opens an interactive terminal in the sandbox. The caller enforces who may use it (an agent
   * PTY needs a session-scoped approval, security §5.4).
   */
  async openPty(sandboxId: string, options: PtyOptions = {}): Promise<SandboxPty> {
    const entry = this.#byId.get(sandboxId);
    if (!entry) return fail("not_found", `sandbox ${sandboxId} not found`);
    const argv = options.argv ?? ["bash", "-l"];
    validateArgv(argv);
    const cwd = validateCwd(options.cwd ?? WORKSPACE_PATH);
    const envPairs = validateEnv({ TERM: "xterm-256color", ...options.env });
    if (entry.ptys >= (this.#options.maxPtys ?? DEFAULT_MAX_PTYS)) {
      fail("rate_limited", `sandbox ${sandboxId} already has the maximum number of terminals`);
    }
    this.#busy(entry);
    entry.ptys += 1;
    let opened = false;
    try {
      await this.#ensureRunning(entry);
      const id = randomBytes(8).toString("hex");
      const cols = String(clampDim(options.cols ?? 80));
      const rows = String(clampDim(options.rows ?? 24));
      const relay = [PYTHON, "-I", "-S", "-c", PTY_RELAY, `${STATE_DIR}/${id}.pid`, cols, rows];
      const stream = this.#driver.stream(
        entry.backend.cli,
        execArgs(entry.backend.kind, entry.container, cwd, [...relay, ...argv]),
      );
      opened = true;
      return createPtySession({
        id,
        sandboxId,
        stream,
        envPairs,
        killGroup: (signal) => this.#signalGroup(entry, id, signal),
        onExit: () => {
          entry.ptys -= 1;
          this.#idle(entry);
        },
      });
    } finally {
      if (!opened) {
        entry.ptys -= 1;
        this.#idle(entry);
      }
    }
  }

  /**
   * Starts a long-lived process with raw stdin / stdout / stderr pipes (issue #143; stdio MCP
   * servers). Same rules as `exec`: UID 1000 in the scope's container with its network, argv
   * validated and never run through a shell, env delivered on stdin (never in host argv or the
   * CLI's environment), no host fallback. It keeps the container busy (no idle stop) until it
   * exits; `kill`, `destroy`, `deleteWorkspace` and `dispose` stop its process group. The
   * scope's workspace counts as untrusted from then on (its writes are not observed).
   */
  async openStdio(sandboxId: string, options: OpenStdioOptions): Promise<SandboxStdio> {
    const entry = this.#entry(sandboxId);
    const argv = options?.argv;
    validateArgv(argv);
    const cwd = validateCwd(options.cwd ?? WORKSPACE_PATH);
    const envPairs = validateEnv(options.env);
    const max = this.#options.maxStdioProcesses ?? DEFAULT_MAX_STDIO_PROCESSES;
    if (entry.stdios.size >= max) {
      fail("rate_limited", `sandbox ${sandboxId} already runs ${max} stdio processes`);
    }
    const id = randomBytes(8).toString("hex");
    // Reserve the slot before awaiting, so concurrent opens respect the limit.
    const slot: { kill(signal?: "TERM" | "KILL"): Promise<void> } = { kill: async () => undefined };
    entry.stdios.set(id, slot);
    this.#busy(entry);
    let opened = false;
    try {
      await this.#ensureRunning(entry);
      await entry.provenance.markUnrecordedUntrusted();
      const stream = this.#driver.stream(
        entry.backend.cli,
        execArgs(entry.backend.kind, entry.container, cwd, [
          PYTHON,
          "-I",
          "-S",
          "-c",
          STDIO_RELAY,
          `${STATE_DIR}/${id}.pid`,
          ...argv,
        ]),
      );
      const body = Buffer.from(envPairs.map((p) => `${p}\0`).join(""), "utf8");
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length);
      stream.stdin.write(Buffer.concat([head, body]));
      opened = true;

      const startedAt = Date.now();
      let killedWith: "TERM" | "KILL" | undefined;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        entry.stdios.delete(id);
        this.#idle(entry);
      };
      const exited = stream.exited.then(
        (r) => {
          release();
          const signal = r.signal ?? (killedWith !== undefined ? signalFromCode(r.exitCode) : null);
          return { exitCode: signal === null ? r.exitCode : null, signal };
        },
        () => {
          release();
          return { exitCode: null, signal: null };
        },
      );
      let killing: Promise<void> | undefined;
      const kill = (signal: "TERM" | "KILL" = "TERM"): Promise<void> => {
        killing ??= (async () => {
          killedWith = signal;
          // Most servers exit on EOF; the group signal covers the rest.
          stream.stdin.end();
          await this.#signalGroup(entry, id, signal);
          if (await settledWithin(exited, KILL_GRACE_MS)) return;
          await this.#signalGroup(entry, id, "KILL");
          if (await settledWithin(exited, 1_000)) return;
          stream.kill("SIGKILL");
        })();
        return killing;
      };
      slot.kill = kill;
      const sandboxIdCopy = entry.instance.id;
      const envNames = envPairs.map((p) => p.slice(0, p.indexOf("=")));
      const receipt = async (): Promise<SandboxStdioReceipt> => {
        const r = await exited;
        return {
          sandboxId: sandboxIdCopy,
          argv: [...argv],
          cwd,
          envNames,
          exitCode: r.exitCode,
          signal: r.signal,
          durationMs: Date.now() - startedAt,
          outcome:
            killedWith !== undefined || r.exitCode === null
              ? "uncertain"
              : r.exitCode === 0
                ? "ok"
                : "failed",
        };
      };
      return {
        sandboxId: sandboxIdCopy,
        stdin: stream.stdin,
        stdout: stream.stdout,
        stderr: stream.stderr,
        exited,
        provenance: "untrusted",
        kill,
        receipt,
      };
    } finally {
      if (!opened) {
        entry.stdios.delete(id);
        this.#idle(entry);
      }
    }
  }

  /** Stops (or with `remove`, deletes) every container this runner started. Volumes stay. */
  async dispose(options: { remove?: boolean } = {}): Promise<void> {
    this.#disposed = true;
    await Promise.allSettled([...this.#pending.values()]);
    const entries = [...this.#byId.values()];
    await Promise.all(
      entries.map(async (entry) => {
        // No server outlives Psyche: TERM their groups, then stop or remove the container.
        await this.#termStdios(entry);
        this.#forget(entry);
        await this.#settle(entry);
        const args = options.remove
          ? removeArgs(entry.backend.kind, entry.container)
          : stopArgs(entry.backend.kind, entry.container);
        await this.#cli(entry.backend, args, { timeoutMs: 60_000 });
      }),
    );
  }

  // ---- internals -------------------------------------------------------------------------

  /** TERM every open stdio process group of this scope (best effort, without waiting). */
  async #termStdios(entry: Entry): Promise<void> {
    const ids = [...entry.stdios.keys()];
    await Promise.allSettled(ids.map((id) => this.#signalGroup(entry, id, "TERM")));
  }

  #entry(sandboxId: string): Entry {
    const entry = this.#byId.get(sandboxId);
    if (!entry) return fail("not_found", `sandbox ${sandboxId} not found`);
    return entry;
  }

  #detect(): Promise<DetectedBackend[]> {
    this.#detected ??= (
      this.#options.detect ??
      (() =>
        detectBackends(systemDetectDeps(this.#driver), {
          ...(this.#options.backend === undefined ? {} : { backend: this.#options.backend }),
          ...(this.#options.cliPaths === undefined ? {} : { cliPaths: this.#options.cliPaths }),
        }))
    )();
    return this.#detected;
  }

  async #primary(): Promise<DetectedBackend> {
    const backend = (await this.#detect())[0];
    if (!backend) {
      return fail(
        "unavailable",
        "no container backend available (Apple container, Docker or Podman); there is no host fallback",
      );
    }
    return backend;
  }

  #names(scope: SandboxScope): { id: string; container: string; volume: string } {
    const hash = createHash("sha256")
      .update(`${this.#prefix}\0${scope.kind}\0${scope.id}`)
      .digest("hex")
      .slice(0, 16);
    return {
      id: `sbx_${hash}`,
      container: `${this.#prefix}-sbx-${hash}`,
      volume: `${this.#prefix}-ws-${hash}`,
    };
  }

  #cli(
    backend: DetectedBackend,
    args: readonly string[],
    options: CliOptions = {},
  ): Promise<CliResult> {
    return this.#driver.start(backend.cli, args, options).done;
  }

  async #create(
    scope: SandboxScope,
    network: SandboxNetwork,
    mounts: SandboxMount[] = [],
  ): Promise<Entry> {
    const backend = await this.#primary();
    await this.#ensureService(backend);
    const { id, container, volume } = this.#names(scope);
    const { image, pinned } = resolveImage(this.#options.variant ?? "base", this.#options.image);
    if (!pinned) await this.#requireImage(backend, image);

    let netName = "none";
    const env: Record<string, string> = {};
    const tunnel = network === "proxy" && this.#options.egressTunnel !== undefined;
    if (tunnel) {
      // K4: no network at all; the shim on the container's own loopback carries every
      // connection to the host-side proxy over stdio.
      const url = `http://127.0.0.1:${EGRESS_SHIM_PORT}`;
      Object.assign(env, {
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
        http_proxy: url,
        https_proxy: url,
        NO_PROXY: "",
        no_proxy: "",
      });
    } else if (network === "proxy") {
      if (backend.kind === "apple-container") {
        // Spike 02: an --internal vmnet exposes every host service bound to 0.0.0.0, so
        // Apple needs the --publish-socket bridge profile, which is not implemented yet.
        return fail(
          "unavailable",
          "network proxy is not supported on Apple container yet (needs the socket bridge)",
        );
      }
      const proxy = this.#options.egressProxy;
      if (!proxy) {
        return fail("unavailable", "network proxy requested but no egress proxy is configured");
      }
      const url = typeof proxy.url === "function" ? await proxy.url(scope) : proxy.url;
      netName = proxy.network;
      const noProxy = proxy.noProxy ?? "";
      Object.assign(env, {
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
        http_proxy: url,
        https_proxy: url,
        NO_PROXY: noProxy,
        no_proxy: noProxy,
      });
    }
    const config = createHash("sha256")
      .update(
        JSON.stringify({
          c: CONTRACT_VERSION,
          image,
          net: netName,
          limits: this.#limits,
          env,
          // A container adopted from an earlier process must have exactly these mounts.
          ...(mounts.length === 0 ? {} : { mounts: mountsKey(mounts) }),
        }),
      )
      .digest("hex")
      .slice(0, 16);
    const spec: RunSpec = {
      name: container,
      image,
      volume,
      network: netName,
      limits: this.#limits,
      labels: {
        [LABEL_PREFIX]: "1",
        [`${LABEL_PREFIX}.contract`]: CONTRACT_VERSION,
        [`${LABEL_PREFIX}.network`]: network,
        [CONFIG_LABEL]: config,
      },
      env,
      ...(mounts.length === 0 ? {} : { mounts }),
    };
    await this.#ensureVolume(backend, volume, image);
    const provenance = await WorkspaceProvenance.load(this.#provenanceStore, scopeKey(scope));
    const entry: Entry = {
      instance: {
        id,
        scope: { kind: scope.kind, id: scope.id },
        backend: backend.kind,
        network,
        workspacePath: WORKSPACE_PATH,
        status: "stopped",
        ...(mounts.length === 0 ? {} : { mounts: mounts.map((m) => ({ ...m })) }),
      },
      backend,
      container,
      volume,
      spec,
      running: false,
      slots: new Semaphore(this.#options.maxConcurrentExecs ?? DEFAULT_MAX_CONCURRENT_EXECS),
      active: 0,
      ptys: 0,
      stdios: new Map(),
      idleTimer: undefined,
      starting: undefined,
      lastUsed: this.#tick++,
      stopping: undefined,
      devServers: new Map(),
      devAdopting: new Set(),
      devPoll: undefined,
      devPolling: false,
      devProbes: new Set(),
      provenance,
      tunnel,
      shim: undefined,
      shimStarting: undefined,
    };
    await this.#ensureRunning(entry);
    if (this.#disposed) {
      // dispose() ran while this sandbox was starting; do not leave an orphan behind.
      this.#live.delete(entry);
      await this.#cli(backend, removeArgs(backend.kind, container), { timeoutMs: 60_000 });
      return fail("unavailable", "sandbox runner is disposed");
    }
    this.#byId.set(id, entry);
    this.#byScope.set(scopeKey(scope), entry);
    this.#idle(entry, false);
    return entry;
  }

  /** Apple's `container` needs its system service; start it once if it is stopped. */
  async #ensureService(backend: DetectedBackend): Promise<void> {
    if (backend.kind !== "apple-container" || this.#appleServiceChecked.has(backend.cli)) return;
    const status = await this.#cli(backend, ["system", "status"], { timeoutMs: 15_000 });
    if (status.exitCode !== 0) {
      const start = await this.#cli(backend, ["system", "start", "--disable-kernel-install"], {
        timeoutMs: 120_000,
      });
      if (start.exitCode !== 0) {
        fail(
          "unavailable",
          `Apple container system service is not running and could not be started; run \`container system start\` once: ${start.stderr.toString("utf8").trim()}`,
        );
      }
    }
    this.#appleServiceChecked.add(backend.cli);
  }

  async #requireImage(backend: DetectedBackend, image: string): Promise<void> {
    const r = await this.#cli(backend, imageInspectArgs(backend.kind, image), {
      timeoutMs: 30_000,
    });
    if (r.exitCode !== 0) {
      fail(
        "unavailable",
        `sandbox image ${image} is not present for ${backend.kind}; build it with \`pnpm --filter @psyche/sandbox sandbox:build\``,
      );
    }
  }

  async #volumeExists(backend: DetectedBackend, volume: string): Promise<boolean> {
    const r = await this.#cli(backend, volumeInspectArgs(backend.kind, volume), {
      timeoutMs: 30_000,
    });
    return r.exitCode === 0;
  }

  async #ensureVolume(backend: DetectedBackend, volume: string, image: string): Promise<void> {
    if (await this.#volumeExists(backend, volume)) return;
    const created = await this.#cli(
      backend,
      volumeCreateArgs(
        backend.kind,
        volume,
        { [LABEL_PREFIX]: "1" },
        this.#options.appleVolumeSize ?? DEFAULT_APPLE_VOLUME_SIZE,
      ),
      { timeoutMs: 60_000 },
    );
    if (created.exitCode !== 0 && !(await this.#volumeExists(backend, volume))) {
      fail("unavailable", `could not create volume ${volume}: ${created.stderr.toString("utf8")}`);
    }
    const init = volumeInitArgs(backend.kind, volume, image);
    if (init) {
      const r = await this.#cli(backend, init, { timeoutMs: 120_000 });
      if (r.exitCode !== 0) {
        fail("unavailable", `could not initialise volume ${volume}: ${r.stderr.toString("utf8")}`);
      }
    }
  }

  async #inspect(entry: Entry): Promise<ContainerState | null> {
    const r = await this.#cli(entry.backend, inspectArgs(entry.backend.kind, entry.container), {
      timeoutMs: 30_000,
    });
    if (r.exitCode !== 0) return null;
    return parseInspect(entry.backend.kind, r.stdout.toString("utf8"));
  }

  /** Starts a stopped container, adopts a matching one, or (re)creates it. */
  #ensureRunning(entry: Entry): Promise<void> {
    if (entry.running) return this.#ensureShim(entry);
    entry.starting ??= (async () => {
      if (entry.stopping) await entry.stopping;
      const release = await this.#startLock.acquire();
      try {
        await this.#makeRoom(entry);
        this.#live.add(entry);
        await this.#startContainer(entry);
      } catch (e) {
        this.#live.delete(entry);
        throw e;
      } finally {
        release();
      }
      entry.running = true;
      entry.instance.status = "ready";
    })().finally(() => {
      entry.starting = undefined;
    });
    return entry.starting.then(() => this.#ensureShim(entry));
  }

  /** Proxy mode: the egress shim runs whenever the container does (restarted if it died). */
  #ensureShim(entry: Entry): Promise<void> {
    const handler = this.#options.egressTunnel;
    if (!entry.tunnel || handler === undefined || entry.shim !== undefined)
      return Promise.resolve();
    entry.shimStarting ??= (async () => {
      const stream = this.#driver.stream(
        entry.backend.cli,
        execArgs(entry.backend.kind, entry.container, "/", [
          PYTHON,
          "-I",
          "-S",
          "-c",
          EGRESS_SHIM,
          String(EGRESS_SHIM_PORT),
        ]),
      );
      const scope = { ...entry.instance.scope };
      const tunnel = attachTunnel(stream, (conn) => handler.handle(scope, conn));
      stream.stderr.resume();
      const shim = { tunnel, stream };
      void stream.exited.then(() => {
        tunnel.close();
        if (entry.shim === shim) entry.shim = undefined;
      });
      const ok = await Promise.race([
        tunnel.ready.then(() => true).catch(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(false), 15_000).unref()),
      ]);
      if (!ok) {
        tunnel.close();
        stream.kill("SIGKILL");
        fail("unavailable", "the sandbox's egress shim did not start");
      }
      entry.shim = shim;
    })().finally(() => {
      entry.shimStarting = undefined;
    });
    return entry.shimStarting;
  }

  #stopShim(entry: Entry): void {
    const shim = entry.shim;
    entry.shim = undefined;
    if (shim === undefined) return;
    shim.tunnel.close();
    shim.stream.kill("SIGTERM");
  }

  /** Adopts a container with a matching config (starting it if stopped), or (re)creates it. */
  async #startContainer(entry: Entry): Promise<void> {
    const state = await this.#inspect(entry);
    const { backend } = entry;
    if (state && state.labels[CONFIG_LABEL] === entry.spec.labels[CONFIG_LABEL]) {
      if (!state.running) {
        const r = await this.#cli(backend, startArgs(backend.kind, entry.container), {
          timeoutMs: 120_000,
        });
        if (r.exitCode !== 0) {
          fail("unavailable", `could not start ${entry.container}: ${r.stderr.toString("utf8")}`);
        }
      }
    } else {
      if (state) {
        await this.#cli(backend, removeArgs(backend.kind, entry.container), {
          timeoutMs: 60_000,
        });
      }
      const r = await this.#cli(backend, runArgs(backend.kind, entry.spec), {
        timeoutMs: 300_000,
        env: { ...process.env, ...entry.spec.env },
      });
      if (r.exitCode !== 0) {
        fail("unavailable", `could not start the sandbox: ${r.stderr.toString("utf8").trim()}`);
      }
    }
  }

  /** Waits for an in-flight start or stop of this entry. */
  async #settle(entry: Entry): Promise<void> {
    if (entry.starting) await entry.starting.catch(() => undefined);
    if (entry.stopping) await entry.stopping;
  }

  /** Stops the container; a start that follows waits for the stop to finish. */
  async #stop(entry: Entry): Promise<void> {
    if (entry.starting) await entry.starting.catch(() => undefined);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    // Stopping the container kills its servers and the egress shim.
    this.#closeDevServers(entry, "sandbox");
    this.#stopShim(entry);
    if (!entry.stopping) {
      entry.running = false;
      entry.instance.status = "stopped";
      this.#live.delete(entry);
      entry.stopping = this.#cli(entry.backend, stopArgs(entry.backend.kind, entry.container), {
        timeoutMs: 60_000,
      })
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          entry.stopping = undefined;
        });
    }
    await entry.stopping;
  }

  #forget(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    this.#closeDevServers(entry, "sandbox");
    this.#stopShim(entry);
    entry.running = false;
    this.#live.delete(entry);
    this.#byId.delete(entry.instance.id);
    this.#byScope.delete(scopeKey(entry.instance.scope));
  }

  /** Keeps the number of running containers under `maxRunningSandboxes`. */
  async #makeRoom(entry: Entry): Promise<void> {
    const max =
      this.#options.maxRunningSandboxes ??
      (entry.backend.kind === "apple-container"
        ? DEFAULT_MAX_RUNNING_APPLE
        : DEFAULT_MAX_RUNNING_SANDBOXES);
    const others = [...this.#live].filter((e) => e !== entry);
    let excess = others.length + 1 - max;
    if (excess <= 0) return;
    const candidates = others.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const victim of candidates) {
      if (excess <= 0) break;
      // Re-checked just before stopping: an earlier stop may have let this one get busy.
      if (victim.active !== 0 || victim.starting !== undefined || !victim.running) continue;
      await this.#stop(victim);
      excess -= 1;
    }
    if (excess > 0) {
      fail("rate_limited", `${max} sandboxes are already running and busy; try again later`);
    }
  }

  #busy(entry: Entry): void {
    entry.lastUsed = this.#tick++;
    entry.active += 1;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  #idle(entry: Entry, decrement = true): void {
    if (decrement) entry.active -= 1;
    const idleMs = this.#options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    // A forwarded dev server keeps its container awake (the browser may be previewing it).
    if (entry.active > 0 || entry.devServers.size > 0) return;
    if (idleMs <= 0 || !this.#byId.has(entry.instance.id)) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.active === 0 && entry.running) void this.#stop(entry).catch(() => undefined);
    }, idleMs);
    entry.idleTimer.unref();
  }

  async #signalGroup(entry: Entry, execId: string, signal: "TERM" | "KILL"): Promise<void> {
    await this.#cli(
      entry.backend,
      execArgs(entry.backend.kind, entry.container, "/", [
        BASH,
        "-c",
        KILL_GROUP,
        "psyche-kill",
        execId,
        signal,
      ]),
      { timeoutMs: 10_000 },
    ).catch(() => undefined);
  }

  async #runCommand(
    entry: Entry,
    argv: string[],
    cwd: string,
    envPairs: string[],
    timeoutMs: number,
    signal: AbortSignal | undefined,
    write: WriteProvenance,
  ): Promise<ExecResult> {
    const execId = randomBytes(8).toString("hex");
    const wrapped = [
      BASH,
      "-c",
      EXEC_WRAPPER,
      "psyche-exec",
      execId,
      (timeoutMs / 1000).toFixed(3),
      // With env, the pairs on stdin go to the trampoline, never to the wrapper shell.
      envPairs.length > 0 ? "--env" : "--",
      ...argv,
    ];
    const proc = this.#driver.start(
      entry.backend.cli,
      execArgs(entry.backend.kind, entry.container, cwd, wrapped),
      { input: envPairs.map((p) => `${p}\0`).join(""), maxBytes: EXEC_OUTPUT_CAP_BYTES },
    );
    let interrupted: "abort" | "timeout" | undefined;
    const interrupt = (why: "abort" | "timeout") => {
      if (interrupted !== undefined) return;
      interrupted = why;
      void (async () => {
        await this.#signalGroup(entry, execId, "TERM");
        if (await settledWithin(proc.done, KILL_GRACE_MS)) return;
        await this.#signalGroup(entry, execId, "KILL");
        if (await settledWithin(proc.done, 1_000)) return;
        proc.kill("SIGKILL");
      })();
    };
    const onAbort = () => interrupt("abort");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    const watchdog = setTimeout(
      () => interrupt("timeout"),
      timeoutMs + KILL_GRACE_MS + HOST_WATCHDOG_SLACK_MS,
    );
    let r: CliResult;
    try {
      r = await proc.done;
    } finally {
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", onAbort);
    }
    // Before `#filesChanged`, which removes the pid file that names the exec's session.
    const reaped = await this.#reapIfNeeded(entry, execId, envPairs);
    if (this.#options.onDevServer !== undefined && !reaped) {
      await this.#probeDevServers(entry, execId, { cwd, argv });
    }
    const filesChanged = await this.#filesChanged(entry, execId);
    const provenance = await this.#recordExecWrites(entry, filesChanged, write);
    // `timeout` exits 124 (TERM) or 137 (KILL after the grace) when the bound was hit.
    const boundHit = (r.exitCode === 124 || r.exitCode === 137) && r.durationMs >= timeoutMs - 50;
    const timedOut = interrupted === "timeout" || (interrupted === undefined && boundHit);
    const killed = interrupted !== undefined || boundHit || r.exitCode === null;
    const exitCode = killed ? null : r.exitCode;
    return {
      exitCode,
      stdout: r.stdout.toString("utf8"),
      stderr: r.stderr.toString("utf8"),
      durationMs: r.durationMs,
      truncated: r.stdoutTruncated || r.stderrTruncated,
      filesChanged: filesChanged ?? [],
      timedOut,
      outcome: killed ? "uncertain" : exitCode === 0 ? "ok" : "failed",
      provenance,
    };
  }

  /**
   * Design-07: what a command wrote carries the calling turn's provenance, and once the
   * workspace holds an untrusted file every command's output and writes are untrusted too (a
   * command may have copied the content). `null` means the changes could not be listed.
   */
  async #recordExecWrites(
    entry: Entry,
    filesChanged: string[] | null,
    write: WriteProvenance,
  ): Promise<"trusted" | "untrusted"> {
    const index = entry.provenance;
    const tainted = write.provenance !== "trusted" || index.hasUntrusted();
    if (!tainted) {
      await index.record(filesChanged ?? [], { provenance: "trusted" });
      return "trusted";
    }
    const sources = [...(write.sources ?? []), ...index.untrustedSources()];
    if (filesChanged === null || filesChanged.length >= FILES_CHANGED_CAP) {
      await index.markUnrecordedUntrusted();
    }
    await index.record(filesChanged ?? [], { provenance: "untrusted", sources });
    return "untrusted";
  }

  // ---- dev servers (feature I12) ------------------------------------------------------------

  async #probe(entry: Entry, args: string[]): Promise<ProbeResult> {
    try {
      const r = await this.#cli(
        entry.backend,
        execArgs(entry.backend.kind, entry.container, "/", [
          PYTHON,
          "-I",
          "-S",
          "-c",
          LISTENERS,
          ...args,
        ]),
        { timeoutMs: 15_000, maxBytes: 256 * 1024 },
      );
      return r.exitCode === 0 ? parseProbe(r.stdout.toString("utf8")) : NO_PROBE;
    } catch {
      return NO_PROBE;
    }
  }

  /** Right after an exec: forward what its session listens on, or re-probe if it is still starting. */
  async #probeDevServers(
    entry: Entry,
    execId: string,
    meta: { cwd: string; argv: string[] },
  ): Promise<void> {
    const r = await this.#probe(entry, ["exec", execId]);
    if (r.sid === null) return;
    await this.#adopt(entry, r, meta);
    if (r.alive && r.listeners.length === 0) this.#reprobe(entry, r.sid, meta);
  }

  /** Background re-probes for a server that binds after its exec returned (`npm run dev &`). */
  #reprobe(entry: Entry, sid: number, meta: { cwd: string; argv: string[] }): void {
    const delays = this.#options.devServers?.probeDelaysMs ?? DEFAULT_DEV_SERVER_PROBE_DELAYS_MS;
    const timers: NodeJS.Timeout[] = [];
    let done = false;
    const cancel = () => {
      done = true;
      for (const t of timers) {
        clearTimeout(t);
        entry.devProbes.delete(t);
      }
    };
    for (const delay of delays) {
      const t = setTimeout(() => {
        entry.devProbes.delete(t);
        if (done || !entry.running || !this.#byId.has(entry.instance.id)) return;
        void this.#probe(entry, ["sid", String(sid)]).then(async (r) => {
          if (done) return;
          await this.#adopt(entry, r, meta);
          if (r.listeners.length > 0 || !r.alive) cancel();
        });
      }, delay);
      t.unref();
      timers.push(t);
      entry.devProbes.add(t);
    }
  }

  async #adopt(entry: Entry, r: ProbeResult, meta: { cwd: string; argv: string[] }): Promise<void> {
    if (r.sid === null) return;
    const sid = r.sid;
    for (const l of r.listeners) {
      if (entry.devServers.has(l.port) || entry.devAdopting.has(l.port)) continue;
      entry.devAdopting.add(l.port);
      try {
        const forward = await PortForward.listen(
          () =>
            this.#driver.stream(
              entry.backend.cli,
              execArgs(entry.backend.kind, entry.container, "/", [
                PYTHON,
                "-I",
                "-S",
                "-c",
                PORT_RELAY,
                l.addr,
                String(l.port),
              ]),
            ),
          this.#options.devServers?.maxConnections ?? DEFAULT_DEV_SERVER_MAX_CONNECTIONS,
        );
        if (!entry.running || !this.#byId.has(entry.instance.id)) {
          await forward.close();
          continue;
        }
        const server: SandboxDevServer = {
          sandboxId: entry.instance.id,
          scope: { ...entry.instance.scope },
          port: forward.port,
          containerPort: l.port,
          pid: sid,
          listenerPid: l.pid,
          cwd: meta.cwd,
          argv: [...meta.argv],
        };
        entry.devServers.set(l.port, { server, forward, sid });
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
        this.#watchDevServers(entry);
        this.#emitDev({ type: "started", server: structuredClone(server) });
      } catch {
        // No loopback port could be bound; nothing is reported.
      } finally {
        entry.devAdopting.delete(l.port);
      }
    }
  }

  /** Polls the forwarded servers' sessions; a listener that is gone is reported `stopped`. */
  #watchDevServers(entry: Entry): void {
    if (entry.devPoll !== undefined) return;
    const pollMs = this.#options.devServers?.pollMs ?? DEFAULT_DEV_SERVER_POLL_MS;
    entry.devPoll = setInterval(() => {
      if (entry.devPolling || !entry.running) return;
      entry.devPolling = true;
      void (async () => {
        const sids = new Set([...entry.devServers.values()].map((d) => d.sid));
        for (const sid of sids) {
          const r = await this.#probe(entry, ["sid", String(sid)]);
          if (r.sid === null) continue;
          const live = new Set(r.listeners.map((l) => l.port));
          for (const [port, d] of entry.devServers) {
            if (d.sid === sid && !live.has(port)) this.#closeDevServer(entry, port, "exited");
          }
          // A server can open more ports later (an HMR socket); forward those too.
          const first = [...entry.devServers.values()].find((d) => d.sid === sid)?.server;
          if (first !== undefined) {
            await this.#adopt(entry, r, { cwd: first.cwd, argv: first.argv });
          }
        }
      })().finally(() => {
        entry.devPolling = false;
      });
    }, pollMs);
    entry.devPoll.unref();
  }

  #closeDevServer(entry: Entry, containerPort: number, reason: DevServerStopReason): void {
    const d = entry.devServers.get(containerPort);
    if (d === undefined) return;
    entry.devServers.delete(containerPort);
    void d.forward.close();
    this.#emitDev({ type: "stopped", server: structuredClone(d.server), reason });
    if (entry.devServers.size === 0) {
      if (entry.devPoll !== undefined) clearInterval(entry.devPoll);
      entry.devPoll = undefined;
      // Nothing is being previewed: the idle timer applies again.
      if (reason === "exited") this.#idle(entry, false);
    }
  }

  #closeDevServers(entry: Entry, reason: DevServerStopReason): void {
    for (const t of entry.devProbes) clearTimeout(t);
    entry.devProbes.clear();
    for (const port of [...entry.devServers.keys()]) this.#closeDevServer(entry, port, reason);
    if (entry.devPoll !== undefined) clearInterval(entry.devPoll);
    entry.devPoll = undefined;
  }

  #emitDev(event: DevServerEvent): void {
    try {
      this.#options.onDevServer?.(event);
    } catch {
      // The listener's problem; forwarding goes on.
    }
  }

  /**
   * Kills what the exec left running when it held a secret (or in `"always"` mode): its
   * session and every process whose environment carries its `PSYCHE_EXEC_MARK`. A failed reap
   * stops the container instead, so a leftover can never outlive the secret it was given.
   */
  async #reapIfNeeded(entry: Entry, execId: string, envPairs: string[]): Promise<boolean> {
    const secret = envPairs.some((p) => p.startsWith("PSYCHE_SECRET_"));
    if (!secret && this.#options.reapBackground !== "always") return false;
    const r = await this.#cli(
      entry.backend,
      execArgs(entry.backend.kind, entry.container, "/", [PYTHON, "-I", "-S", "-c", REAP, execId]),
      { timeoutMs: 30_000 },
    ).catch(() => undefined);
    if (r === undefined || r.exitCode !== 0) {
      await this.#stop(entry).catch(() => undefined);
    }
    return true;
  }

  async #filesChanged(entry: Entry, execId: string): Promise<string[] | null> {
    try {
      const r = await this.#cli(
        entry.backend,
        execArgs(entry.backend.kind, entry.container, "/", [
          BASH,
          "-c",
          FILES_CHANGED,
          "psyche-changed",
          execId,
          String(FILES_CHANGED_CAP),
        ]),
        { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 },
      );
      if (r.exitCode !== 0) {
        // The script always exits 0, so this is the CLI: the container may be gone. The
        // next call re-inspects it instead of trusting the cached state.
        entry.running = false;
        return null;
      }
      return r.stdout.toString("utf8").split("\0").filter(plainRelative);
    } catch {
      return null;
    }
  }

  async #helper(
    sandboxId: string,
    argv: string[],
    options: { input?: Uint8Array | string; maxBytes: number },
  ): Promise<CliResult> {
    const entry = this.#entry(sandboxId);
    this.#busy(entry);
    try {
      await this.#ensureRunning(entry);
      return await this.#cli(
        entry.backend,
        execArgs(entry.backend.kind, entry.container, WORKSPACE_PATH, argv),
        { ...options, timeoutMs: 120_000 },
      );
    } finally {
      this.#idle(entry);
    }
  }
}

export function createSandboxRunner(
  options: ContainerSandboxRunnerOptions = {},
): ContainerSandboxRunner {
  return new ContainerSandboxRunner(options);
}

export type { ContainerBackendKind };
