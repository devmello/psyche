import { createHash, randomBytes } from "node:crypto";
import type {
  ExecRequest,
  ExecResult,
  SandboxBackendKind,
  SandboxInstance,
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
import { type CliDriver, type CliOptions, type CliResult, nodeCliDriver } from "./cli.ts";
import {
  type DetectedBackend,
  type DetectOptions,
  detectBackends,
  systemDetectDeps,
} from "./detect.ts";
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
import { createPtySession, type PtyOptions, type SandboxPty } from "./pty.ts";
import { EXEC_WRAPPER, FILES_CHANGED, KILL_GROUP, PTY_RELAY, STATE_DIR } from "./scripts.ts";
import { Semaphore } from "./sync.ts";
import {
  validateArgv,
  validateCwd,
  validateEnv,
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

export interface ContainerSandboxRunnerOptions extends DetectOptions {
  /** Image reference; default from versions.json or the local dev tag (see image.ts). */
  image?: string;
  /** Default `"base"`. */
  variant?: ImageVariant;
  limits?: Partial<SandboxLimits>;
  /** Stop a container after this long without work. 0 disables. Default 10 min. */
  idleTimeoutMs?: number;
  /** Concurrent `exec` calls per scope; extra calls queue. Default 4. */
  maxConcurrentExecs?: number;
  /** Open PTYs per scope. Default 4. */
  maxPtys?: number;
  /**
   * Running containers across all scopes; above it the least recently used idle one is
   * stopped. Default 3 on Apple `container` (each is a VM that keeps freed guest memory,
   * spike 02) and 8 elsewhere.
   */
  maxRunningSandboxes?: number;
  /** Largest accepted `timeoutMs`. Default 30 min. */
  maxTimeoutMs?: number;
  egressProxy?: EgressProxyConfig;
  /** Prefix for container and volume names. Default `"psyche"`. */
  namePrefix?: string;
  /** Apple volumes are fixed-size ext4 images. Default `"8G"`. */
  appleVolumeSize?: string;
  driver?: CliDriver;
  /** Replaces host detection (tests). */
  detect?: () => Promise<DetectedBackend[]>;
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
  idleTimer: NodeJS.Timeout | undefined;
  starting: Promise<void> | undefined;
  lastUsed: number;
}

const CONFIG_LABEL = `${LABEL_PREFIX}.config`;

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

/** CLI errors (container gone, daemon down) rather than the command's own failure. */
function looksLikeCliError(r: CliResult): boolean {
  const text = r.stderr.toString("utf8", 0, Math.min(r.stderr.length, 512));
  return /^(Error response from daemon|Error: |Error: container|error: )/m.test(text);
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
  readonly #prefix: string;
  #detected: Promise<DetectedBackend[]> | undefined;
  readonly #byId = new Map<string, Entry>();
  readonly #byScope = new Map<string, Entry>();
  readonly #pending = new Map<string, Promise<Entry>>();
  readonly #appleServiceChecked = new Set<string>();
  #disposed = false;
  #tick = 0;

  constructor(options: ContainerSandboxRunnerOptions = {}) {
    this.#options = options;
    this.#driver = options.driver ?? nodeCliDriver;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#prefix = options.namePrefix ?? "psyche";
    this.files = new WorkspaceFiles((id, argv, opts) => this.#helper(id, argv, opts));
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
    options: { network?: SandboxNetwork } = {},
  ): Promise<SandboxInstance> {
    validateScope(scope);
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
      await this.#ensureRunning(existing);
      return structuredClone(existing.instance);
    }
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = this.#create(scope, network).finally(() => this.#pending.delete(key));
      this.#pending.set(key, pending);
    }
    const entry = await pending;
    if (entry.instance.network !== network) {
      fail("conflict", `sandbox for ${key} runs with network ${entry.instance.network}`);
    }
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
      return await this.#runCommand(entry, request.argv, cwd, envPairs, timeoutMs, request.signal);
    } finally {
      release();
      this.#idle(entry);
    }
  }

  /** Removes the container. The workspace volume stays; `deleteWorkspace` removes it. */
  async destroy(sandboxId: string): Promise<void> {
    const entry = this.#byId.get(sandboxId);
    if (!entry) return;
    this.#forget(entry);
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
    if (entry) this.#forget(entry);
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
      const cols = String(Math.max(1, Math.trunc(options.cols ?? 80)));
      const rows = String(Math.max(1, Math.trunc(options.rows ?? 24)));
      const relay = ["python3", "-I", "-S", "-c", PTY_RELAY, `${STATE_DIR}/${id}.pid`, cols, rows];
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

  /** Stops (or with `remove`, deletes) every container this runner started. Volumes stay. */
  async dispose(options: { remove?: boolean } = {}): Promise<void> {
    this.#disposed = true;
    const entries = [...this.#byId.values()];
    await Promise.all(
      entries.map(async (entry) => {
        this.#forget(entry);
        const args = options.remove
          ? removeArgs(entry.backend.kind, entry.container)
          : stopArgs(entry.backend.kind, entry.container);
        await this.#cli(entry.backend, args, { timeoutMs: 60_000 });
      }),
    );
  }

  // ---- internals -------------------------------------------------------------------------

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

  async #create(scope: SandboxScope, network: SandboxNetwork): Promise<Entry> {
    const backend = await this.#primary();
    await this.#ensureService(backend);
    const { id, container, volume } = this.#names(scope);
    const { image, pinned } = resolveImage(this.#options.variant ?? "base", this.#options.image);
    if (!pinned) await this.#requireImage(backend, image);

    let netName = "none";
    const env: Record<string, string> = {};
    if (network === "proxy") {
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
        JSON.stringify({ c: CONTRACT_VERSION, image, net: netName, limits: this.#limits, env }),
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
    };
    await this.#ensureVolume(backend, volume, image);
    const entry: Entry = {
      instance: {
        id,
        scope: { kind: scope.kind, id: scope.id },
        backend: backend.kind,
        network,
        workspacePath: WORKSPACE_PATH,
        status: "stopped",
      },
      backend,
      container,
      volume,
      spec,
      running: false,
      slots: new Semaphore(this.#options.maxConcurrentExecs ?? DEFAULT_MAX_CONCURRENT_EXECS),
      active: 0,
      ptys: 0,
      idleTimer: undefined,
      starting: undefined,
      lastUsed: this.#tick++,
    };
    await this.#ensureRunning(entry);
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
    if (entry.running) return Promise.resolve();
    entry.starting ??= (async () => {
      await this.#makeRoom(entry);
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
      entry.running = true;
      entry.instance.status = "ready";
    })().finally(() => {
      entry.starting = undefined;
    });
    return entry.starting;
  }

  async #stop(entry: Entry): Promise<void> {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.running = false;
    entry.instance.status = "stopped";
    await this.#cli(entry.backend, stopArgs(entry.backend.kind, entry.container), {
      timeoutMs: 60_000,
    });
  }

  #forget(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.running = false;
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
    const others = [...this.#byId.values()].filter((e) => e !== entry && e.running);
    let excess = others.length + 1 - max;
    if (excess <= 0) return;
    const idle = others
      .filter((e) => e.active === 0 && e.starting === undefined)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const victim of idle) {
      if (excess <= 0) break;
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
    if (entry.active > 0 || idleMs <= 0 || !this.#byId.has(entry.instance.id)) return;
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
        "bash",
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
  ): Promise<ExecResult> {
    const execId = randomBytes(8).toString("hex");
    const wrapped = [
      "bash",
      "-c",
      EXEC_WRAPPER,
      "psyche-exec",
      execId,
      (timeoutMs / 1000).toFixed(3),
      "--",
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
    if (r.exitCode !== 0 && looksLikeCliError(r)) entry.running = false;
    const filesChanged = await this.#filesChanged(entry, execId);
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
      filesChanged,
      timedOut,
      outcome: killed ? "uncertain" : exitCode === 0 ? "ok" : "failed",
    };
  }

  async #filesChanged(entry: Entry, execId: string): Promise<string[]> {
    if (!entry.running) return [];
    try {
      const r = await this.#cli(
        entry.backend,
        execArgs(entry.backend.kind, entry.container, "/", [
          "bash",
          "-c",
          FILES_CHANGED,
          "psyche-changed",
          execId,
          String(FILES_CHANGED_CAP),
        ]),
        { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 },
      );
      if (r.exitCode !== 0) return [];
      return r.stdout
        .toString("utf8")
        .split("\0")
        .filter((p) => p !== "");
    } catch {
      return [];
    }
  }

  async #helper(
    sandboxId: string,
    argv: string[],
    options: { input?: Uint8Array | string; maxBytes: number },
  ): Promise<CliResult> {
    const entry = this.#byId.get(sandboxId);
    if (!entry) return fail("not_found", `sandbox ${sandboxId} not found`);
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
