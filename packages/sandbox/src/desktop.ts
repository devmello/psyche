import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { buildArgs, type ContainerBackendKind, execArgs, parseInspect } from "./backends.ts";
import { PsycheError } from "@psyche/protocol";
import { type CliDriver, nodeCliDriver, runCli } from "./cli.ts";
import { type DetectDeps, type DetectOptions, detectBackends, systemDetectDeps } from "./detect.ts";
import { attachTunnel, type EgressTunnel } from "./egress/tunnel.ts";
import { IMAGE_CONTEXT_DIR, IMAGE_ENV, imageVersions } from "./image.ts";
import { SANDBOX_GID, SANDBOX_UID, WORKSPACE_PATH } from "./limits.ts";
import { EGRESS_SHIM_PORT, type EgressTunnelHandler } from "./runner.ts";
import { EGRESS_SHIM, PYTHON } from "./scripts.ts";

/**
 * The separate desktop's container (docs/design/linux-desktop-2026.md section 8): a rootless
 * Podman (or Docker) container built from the `desktop` target of `deploy/sandbox-image`, with
 * its own apps and files, that the Gateway drives through the helper inside it. This module is
 * only the lifecycle: argv builders, detection, start, stop, reset and the egress shim. Who may
 * share which folder, and how the helper inside pairs, is the Gateway's (`separate-desktop.ts`,
 * `guest-sockets.ts`).
 *
 * Contract, all of it enforced here and never relaxed by a caller:
 * - UID/GID 1000 (`--userns=keep-id` on Podman so the host user owns what the container writes),
 *   read-only root filesystem, `/tmp` a tmpfs, `/workspace` a named volume, every capability
 *   dropped, `no-new-privileges`, no network at all (`--network=none`), a memory cap with no swap.
 * - Nothing of the host is mounted except the one guest socket and the shares the caller passes,
 *   read-only unless the share says otherwise; each share is checked again here.
 * - No daemon of our own and nothing running between Tasks: a container exists only while the
 *   desktop runs. It is removed at stop (its pairing token is single use and lives in its
 *   environment); only the workspace volume stays, until a reset.
 */

const errors = {
  invalid: (message: string) => new PsycheError("invalid_params", message),
  forbidden: (message: string) => new PsycheError("forbidden", message),
  notFound: (message: string) => new PsycheError("not_found", message),
  unavailable: (message: string, details?: Record<string, unknown>) =>
    new PsycheError("unavailable", message, details === undefined ? {} : { details }),
};

export type DesktopBackendKind = Extract<ContainerBackendKind, "podman" | "docker">;

export interface DesktopBackend {
  kind: DesktopBackendKind;
  cli: string;
  version: string;
  /** Rootless engine: container root is not host root. Rootful ones run, with a warning. */
  rootless: boolean;
}

export const ROOTFUL_WARNING =
  "This container engine runs as root. A bug that escapes the container would give an attacker root on this computer. Use rootless Podman for the separate desktop.";

export const DESKTOP_OWNER_LABEL = "com.psyche.owner";
export const DESKTOP_ID_LABEL = "com.psyche.desktop";
export const DESKTOP_SHARES_LABEL = "com.psyche.shares";
export const DESKTOP_SOCKET_TARGET = "/run/psyche/node.sock";
export const DESKTOP_TOKEN_ENV = "PSYCHE_GUEST_TOKEN";
export const DESKTOP_SHARES_ROOT = "/shares";
export const DEFAULT_DESKTOP_MEMORY = "2g";
export const DESKTOP_MAX_SHARES = 8;
const DESKTOP_PIDS_LIMIT = 1024;
const DESKTOP_TMP_MB = 256;
const DESKTOP_SHM = "256m";

const ID_RE = /^[a-z0-9]{1,16}$/;
const SHARE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MEMORY_RE = /^([1-9][0-9]{0,4})([mg])$/;

export interface DesktopShare {
  /** The host folder, as its own real path. */
  source: string;
  /** Appears at `/shares/<name>`. */
  name: string;
  readOnly: boolean;
}

export interface DesktopSpec {
  /** One desktop per id (`^[a-z0-9]{1,16}$`). */
  id: string;
  image: string;
  /** The per-container Gateway socket on the host. */
  socketPath: string;
  /** Single-use; passed by name, the value rides the CLI's environment. */
  token: string;
  /** Already validated (`validateDesktopShares`). */
  shares: readonly DesktopShare[];
  memory: string;
}

export function desktopNames(id: string): { container: string; volume: string } {
  if (!ID_RE.test(id)) {
    throw errors.invalid(
      `a separate desktop id is 1 to 16 lowercase letters or digits, not ${JSON.stringify(id)}`,
    );
  }
  return { container: `psyche-desktop-${id}`, volume: `psyche-desktop-${id}-workspace` };
}

/** `2g` / `1536m`, 512 MB to 16 GB: anything else is refused, never rounded into something larger. */
export function validateDesktopMemory(value: string | undefined): string {
  const v = value ?? DEFAULT_DESKTOP_MEMORY;
  const m = MEMORY_RE.exec(v);
  if (m === null) throw errors.invalid(`memory is like 2g or 1536m, not ${JSON.stringify(v)}`);
  const mb = Number(m[1]) * (m[2] === "g" ? 1024 : 1);
  if (mb < 512 || mb > 16 * 1024) throw errors.invalid("memory must be between 512m and 16g");
  return v;
}

/** Order-independent identity of the share list, kept on the container as a label. */
export function sharesKey(shares: readonly DesktopShare[]): string {
  const rows = shares.map((s) => [s.name, s.source, s.readOnly] as const);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
}

/** System places no share may be, or contain, whoever approved it. */
const NEVER_EXACT = ["/", "/home", "/tmp", "/var", "/mnt", "/media", "/opt", "/srv", "/usr"];
const NEVER_SUBTREE = [
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/boot",
  "/etc",
  "/root",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/var/run",
  "/var/lib",
  "/var/log",
  "/snap",
  "/tmp/.X11-unix",
];
/** Under the home folder, refused with everything below: keys, sessions, stores, engines. */
const NEVER_UNDER_HOME = [
  ".ssh",
  ".gnupg",
  ".config",
  ".local/share",
  ".local/state",
  ".cache",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".netrc",
  ".npmrc",
  ".git-credentials",
  ".psyche",
  ".mozilla",
  ".thunderbird",
  ".pki",
  ".password-store",
  ".var",
  ".steam",
];

const under = (child: string, root: string): boolean =>
  root === "/" ? true : child === root || child.startsWith(`${root}/`);

export interface ShareCheckOptions {
  /** Extra places that are never shared (`$PSYCHE_HOME`, the Gateway's protected roots). */
  protectedRoots?: readonly string[];
  /** The owner's home folder; default this user's. */
  home?: string;
}

/**
 * Checks every share again at the point of mounting, whatever approval came before: a source that
 * is not its own real path (a link could be pointed anywhere after the check), is not a folder,
 * is `/`, the home folder or an ancestor of it, is or contains a credential store, a protected
 * root, a system folder or the engine's own storage. Names and paths are also refused if they
 * could add options to `--mount` (a comma, `=`). Returns the shares sorted by name.
 */
export async function validateDesktopShares(
  shares: readonly DesktopShare[],
  options: ShareCheckOptions = {},
): Promise<DesktopShare[]> {
  if (shares.length > DESKTOP_MAX_SHARES) {
    throw errors.invalid(`at most ${DESKTOP_MAX_SHARES} shared folders`);
  }
  const home = posix.normalize(options.home ?? homedir());
  const subtree = new Set<string>([
    ...NEVER_SUBTREE,
    ...NEVER_UNDER_HOME.map((p) => posix.join(home, p)),
    ...(options.protectedRoots ?? []).map((p) => posix.normalize(p)),
  ]);
  const out: DesktopShare[] = [];
  const seen = new Set<string>();
  for (const s of shares) {
    if (
      typeof s?.source !== "string" ||
      typeof s.name !== "string" ||
      typeof s.readOnly !== "boolean"
    ) {
      throw errors.invalid("a share is {source, name, readOnly}");
    }
    if (!SHARE_NAME_RE.test(s.name) || seen.has(s.name)) {
      throw errors.invalid(`share name ${JSON.stringify(s.name)} is not allowed or is used twice`);
    }
    seen.add(s.name);
    const { source } = s;
    if (
      !source.startsWith("/") ||
      /[\0,=\n\r]/.test(source) ||
      posix.normalize(source) !== source ||
      (source.length > 1 && source.endsWith("/"))
    ) {
      throw errors.forbidden(`share path ${JSON.stringify(source)} is not allowed`);
    }
    const refuse = async (path: string): Promise<void> => {
      const roots = new Set<string>(subtree);
      for (const p of subtree) {
        try {
          roots.add(await realpath(p));
        } catch {
          // Not there: the written path is enough.
        }
      }
      if (
        NEVER_EXACT.includes(path) ||
        under(home, path) ||
        [...roots].some((r) => under(path, r) || under(r, path))
      ) {
        throw errors.forbidden(`${path} is never shared with a separate desktop`);
      }
    };
    // Judged as written first (a path that does not exist is still never allowed), then as the
    // real path it must be.
    await refuse(source);
    let real: string;
    try {
      real = await realpath(source);
      if (!(await stat(real)).isDirectory()) throw errors.invalid(`${source} is not a folder`);
    } catch (err) {
      if ((err as { code?: string }).code === "invalid_params") throw err;
      throw errors.notFound(`share ${source} does not exist`);
    }
    if (real !== source) throw errors.forbidden(`share ${source} goes through a symlink`);
    await refuse(real);
    out.push({ source, name: s.name, readOnly: s.readOnly });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

function labelFlags(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
}

/** Environment the container gets: only names on argv, values come from the CLI's environment. */
export function desktopEnv(token: string): Record<string, string> {
  const proxy = `http://127.0.0.1:${EGRESS_SHIM_PORT}`;
  return {
    [DESKTOP_TOKEN_ENV]: token,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: "",
    no_proxy: "",
  };
}

/**
 * `run -d …` for the desktop. Podman and Docker only: the design needs a Linux container with a
 * bind-mounted Unix socket and a graphical stack, which Apple `container` is not offered for.
 */
export function desktopRunArgs(kind: DesktopBackendKind, spec: DesktopSpec): string[] {
  const { container, volume } = desktopNames(spec.id);
  validateDesktopMemory(spec.memory);
  if (/[\0,=\n\r]/.test(spec.socketPath) || !spec.socketPath.startsWith("/")) {
    throw errors.forbidden("the guest socket path is not allowed");
  }
  const mounts = [
    "--mount",
    `type=volume,source=${volume},target=${WORKSPACE_PATH}`,
    // Read-only mount of the one socket: connecting works, replacing it does not.
    "--mount",
    `type=bind,source=${spec.socketPath},target=${DESKTOP_SOCKET_TARGET},readonly`,
    ...spec.shares.flatMap((s) => [
      "--mount",
      kind === "podman"
        ? `type=bind,source=${s.source},target=${DESKTOP_SHARES_ROOT}/${s.name},nosuid,nodev,noexec${s.readOnly ? ",readonly" : ""}`
        : `type=bind,source=${s.source},target=${DESKTOP_SHARES_ROOT}/${s.name}${s.readOnly ? ",readonly" : ""}`,
    ]),
  ];
  return [
    "run",
    "--detach",
    "--rm=false",
    "--name",
    container,
    "--pull=never",
    "--network=none",
    ...(kind === "podman" ? [`--userns=keep-id:uid=${SANDBOX_UID},gid=${SANDBOX_GID}`] : []),
    "--user",
    `${SANDBOX_UID}:${SANDBOX_GID}`,
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${DESKTOP_TMP_MB}m`,
    "--shm-size",
    DESKTOP_SHM,
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    `--memory=${spec.memory}`,
    `--memory-swap=${spec.memory}`,
    "--pids-limit",
    String(DESKTOP_PIDS_LIMIT),
    ...mounts,
    ...labelFlags({
      [DESKTOP_OWNER_LABEL]: "1",
      [DESKTOP_ID_LABEL]: spec.id,
      [DESKTOP_SHARES_LABEL]: sharesKey(spec.shares),
    }),
    ...Object.keys(desktopEnv("x")).flatMap((k) => ["-e", k]),
    spec.image,
  ];
}

/** The image: option, `PSYCHE_SANDBOX_IMAGE`, the published digest, then the local dev tag. */
export function resolveDesktopImage(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): { image: string; pinned: boolean } {
  if (explicit !== undefined && explicit !== "") return { image: explicit, pinned: false };
  const fromEnv = env[IMAGE_ENV];
  if (fromEnv !== undefined && fromEnv !== "") return { image: fromEnv, pinned: false };
  const digest: string | null = imageVersions.variants.desktop.digest;
  if (digest !== null) return { image: `${imageVersions.repository}@${digest}`, pinned: true };
  return { image: "psyche-sandbox:desktop-dev", pinned: false };
}

export interface DesktopOptions extends DetectOptions {
  image?: string;
  driver?: CliDriver;
  detectDeps?: DetectDeps;
  /** Where `build` finds the Dockerfile; default `deploy/sandbox-image`. */
  contextDir?: string;
  now?: () => number;
  home?: string;
}

export interface DesktopStartRequest {
  id: string;
  socketPath: string;
  token: string;
  shares?: readonly DesktopShare[];
  /** `2g` by default (`validateDesktopMemory`). */
  memory?: string;
  protectedRoots?: readonly string[];
}

export interface DesktopStarted {
  container: string;
  /** Wall time of `run`, the container is up when it returns. */
  startMs: number;
  backend: DesktopBackend;
}

export interface DesktopStatus {
  exists: boolean;
  running: boolean;
  sharesKey?: string;
}

/**
 * The lifecycle. Every host process it starts is `podman`/`docker` with an argument array.
 * Nothing here keeps state: the engine's own container list is the truth, so a Gateway restart
 * finds what is left (`reconcile`).
 */
export class DesktopContainers {
  readonly #options: DesktopOptions;
  readonly #driver: CliDriver;
  #backend: DesktopBackend | null | undefined;

  constructor(options: DesktopOptions = {}) {
    this.#options = options;
    this.#driver = options.driver ?? nodeCliDriver;
  }

  /** Podman first, then Docker. Never Apple `container`, never a backend the owner did not pick. */
  async backend(): Promise<DesktopBackend | undefined> {
    if (this.#backend !== undefined) return this.#backend ?? undefined;
    const deps = this.#options.detectDeps ?? systemDetectDeps(this.#driver);
    const found = (await detectBackends(deps, this.#options)).filter(
      (b): b is typeof b & { kind: DesktopBackendKind } =>
        b.kind === "podman" || b.kind === "docker",
    );
    found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "podman" ? -1 : 1));
    const first = found[0];
    if (first === undefined) {
      this.#backend = null;
      return undefined;
    }
    const probe =
      first.kind === "podman"
        ? await deps.probe(first.cli, ["info", "--format", "{{.Host.Security.Rootless}}"])
        : await deps.probe(first.cli, ["info", "--format", "{{.SecurityOptions}}"]);
    const rootless =
      first.kind === "podman"
        ? probe?.trim() === "true"
        : /(^|[ \[,])name=rootless/.test(probe ?? "");
    this.#backend = { ...first, rootless };
    return this.#backend;
  }

  async requireBackend(): Promise<DesktopBackend> {
    const b = await this.backend();
    if (b === undefined) {
      throw errors.unavailable(
        "the separate desktop needs Podman (or Docker). Install Podman, then try again.",
        { reason: "no_container_engine" },
      );
    }
    return b;
  }

  #cli(
    backend: DesktopBackend,
    args: string[],
    opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
  ) {
    return runCli(this.#driver, backend.cli, args, {
      timeoutMs: opts.timeoutMs ?? 60_000,
      maxBytes: 256 * 1024,
      ...(opts.env === undefined ? {} : { env: opts.env }),
    });
  }

  image(): { image: string; pinned: boolean } {
    return resolveDesktopImage(this.#options.image);
  }

  /** Whether the image is on this computer, and its size: shown before anything is pulled. */
  async imageStatus(): Promise<{
    present: boolean;
    image: string;
    pinned: boolean;
    sizeBytes?: number;
  }> {
    const backend = await this.requireBackend();
    const ref = this.image();
    const r = await this.#cli(backend, ["image", "inspect", "--format", "{{.Size}}", ref.image]);
    const size = Number.parseInt(r.stdout.toString("utf8").trim(), 10);
    return {
      present: r.exitCode === 0,
      ...ref,
      ...(r.exitCode === 0 && Number.isFinite(size) ? { sizeBytes: size } : {}),
    };
  }

  /** Builds the `desktop` target from this checkout (the dev path; a release pulls a pinned digest). */
  async build(
    options: { tag?: string; timeoutMs?: number } = {},
  ): Promise<{ tag: string; durationMs: number }> {
    const backend = await this.requireBackend();
    const tag = options.tag ?? resolveDesktopImage(undefined, {}).image;
    const r = await this.#cli(
      backend,
      buildArgs(backend.kind, this.#options.contextDir ?? IMAGE_CONTEXT_DIR, tag, "desktop"),
      { timeoutMs: options.timeoutMs ?? 30 * 60_000 },
    );
    if (r.exitCode !== 0) {
      throw errors.unavailable(
        `desktop image build failed: ${r.stderr.toString("utf8").slice(-2000)}`,
        {
          reason: "image_build_failed",
        },
      );
    }
    return { tag, durationMs: r.durationMs };
  }

  /**
   * Makes sure the image is there. A pinned release image is pulled at first use (the caller shows
   * `sizeBytes` first); an unpinned one is never pulled (it is a local build or the owner's own
   * choice), so a missing one is an error that says how to build it.
   */
  async ensureImage(): Promise<void> {
    const backend = await this.requireBackend();
    const status = await this.imageStatus();
    if (status.present) return;
    if (!status.pinned) {
      throw errors.unavailable(
        `the separate desktop image ${status.image} is not on this computer. Build it from deploy/sandbox-image (see its README, "The desktop target").`,
        { reason: "image_missing", image: status.image },
      );
    }
    const r = await this.#cli(backend, ["pull", "--quiet", status.image], {
      timeoutMs: 30 * 60_000,
    });
    if (r.exitCode !== 0) {
      throw errors.unavailable(
        `could not download the separate desktop: ${r.stderr.toString("utf8").slice(-1000)}`,
        {
          reason: "image_pull_failed",
        },
      );
    }
  }

  async status(id: string): Promise<DesktopStatus> {
    const backend = await this.requireBackend();
    const { container } = desktopNames(id);
    const r = await this.#cli(backend, ["inspect", container]);
    if (r.exitCode !== 0) return { exists: false, running: false };
    const state = parseInspect(backend.kind, r.stdout.toString("utf8"));
    if (state === null) return { exists: false, running: false };
    const key = state.labels[DESKTOP_SHARES_LABEL];
    return {
      exists: true,
      running: state.running,
      ...(key === undefined ? {} : { sharesKey: key }),
    };
  }

  /**
   * Creates and starts the desktop. A container left from an earlier start is removed first: its
   * token is spent and its mounts are the old ones. Fails closed on anything unexpected: the
   * container is removed again if it did not come up.
   */
  async start(request: DesktopStartRequest): Promise<DesktopStarted> {
    const backend = await this.requireBackend();
    const memory = validateDesktopMemory(request.memory);
    const shares = await validateDesktopShares(request.shares ?? [], {
      ...(request.protectedRoots === undefined ? {} : { protectedRoots: request.protectedRoots }),
      ...(this.#options.home === undefined ? {} : { home: this.#options.home }),
    });
    if (request.token.length < 32) throw errors.invalid("the pairing token is too short");
    await this.ensureImage();
    const { container, volume } = desktopNames(request.id);
    await this.#remove(backend, container);
    const now = this.#options.now ?? Date.now;
    const began = now();
    const image = this.image().image;
    const args = desktopRunArgs(backend.kind, {
      id: request.id,
      image,
      socketPath: request.socketPath,
      token: request.token,
      shares,
      memory,
    });
    // The workspace volume belongs to this desktop and is kept across starts.
    const made = await this.#cli(backend, [
      "volume",
      "create",
      // The workspace outlives every start; Podman refuses a second create unless told to ignore it.
      ...(backend.kind === "podman" ? ["--ignore"] : []),
      "--label",
      `${DESKTOP_OWNER_LABEL}=1`,
      volume,
    ]);
    if (made.exitCode !== 0) {
      throw errors.unavailable(
        `could not prepare the desktop's workspace: ${made.stderr.toString("utf8").slice(-500)}`,
      );
    }
    const ran = await this.#cli(backend, args, {
      timeoutMs: 120_000,
      env: { ...process.env, ...desktopEnv(request.token) },
    });
    if (ran.exitCode !== 0) {
      await this.#remove(backend, container);
      throw errors.unavailable(
        `the separate desktop did not start: ${ran.stderr.toString("utf8").slice(-1000)}`,
        {
          reason: "start_failed",
        },
      );
    }
    const st = await this.status(request.id);
    if (!st.running) {
      await this.#remove(backend, container);
      throw errors.unavailable("the separate desktop stopped right after it started", {
        reason: "start_failed",
      });
    }
    return { container, startMs: now() - began, backend };
  }

  /** Stops and removes the container (not its workspace). Absent is fine. */
  async stop(id: string): Promise<void> {
    const backend = await this.requireBackend();
    const { container } = desktopNames(id);
    await this.#cli(backend, ["stop", "-t", "2", container], { timeoutMs: 30_000 });
    await this.#remove(backend, container);
  }

  /** "Reset separate desktop": the container and its workspace volume. */
  async reset(id: string): Promise<void> {
    const backend = await this.requireBackend();
    const { container, volume } = desktopNames(id);
    await this.#remove(backend, container);
    const r = await this.#cli(backend, ["volume", "rm", "--force", volume]);
    if (r.exitCode !== 0 && !/no such volume/i.test(r.stderr.toString("utf8"))) {
      throw errors.unavailable(
        `could not delete the desktop's workspace: ${r.stderr.toString("utf8").slice(-500)}`,
      );
    }
  }

  /**
   * Removes every container this app made that is still around (a crashed Gateway left it with a
   * spent token and no socket). Returns the ids removed. Only ever labelled ones: never a
   * container the owner made themselves.
   */
  async reconcile(): Promise<string[]> {
    const backend = await this.backend();
    if (backend === undefined) return [];
    const r = await this.#cli(backend, [
      "ps",
      "--all",
      "--filter",
      `label=${DESKTOP_OWNER_LABEL}=1`,
      "--format",
      "{{.Names}}",
    ]);
    if (r.exitCode !== 0) return [];
    const ids: string[] = [];
    for (const name of r.stdout.toString("utf8").split("\n")) {
      const m = /^psyche-desktop-([a-z0-9]{1,16})$/.exec(name.trim());
      if (m?.[1] === undefined) continue;
      await this.#remove(backend, name.trim());
      ids.push(m[1]);
    }
    return ids;
  }

  /**
   * Internet for the running desktop, only through the egress proxy: the container keeps no
   * network at all, and a shim inside it (on the container's own loopback) carries each connection
   * to `handler` over stdio, with the scope's allowlist and approvals. Close it to cut the
   * internet again. Never host networking, never the host's loopback or LAN.
   */
  async openEgress(
    id: string,
    scope: Parameters<EgressTunnelHandler["handle"]>[0],
    handler: EgressTunnelHandler,
  ): Promise<{ close(): void }> {
    const backend = await this.requireBackend();
    const { container } = desktopNames(id);
    const stream = this.#driver.stream(
      backend.cli,
      execArgs(backend.kind, container, "/", [
        PYTHON,
        "-I",
        "-S",
        "-c",
        EGRESS_SHIM,
        String(EGRESS_SHIM_PORT),
      ]),
    );
    stream.stderr.resume();
    const tunnel: EgressTunnel = attachTunnel(stream, (conn) => handler.handle({ ...scope }, conn));
    const closed = () => {
      tunnel.close();
      stream.kill("SIGTERM");
    };
    void stream.exited.then(() => tunnel.close());
    const ok = await Promise.race([
      tunnel.ready.then(() => true).catch(() => false),
      stream.exited.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 15_000).unref()),
    ]);
    if (!ok) {
      closed();
      throw errors.unavailable("the separate desktop's internet connection did not start", {
        reason: "egress_failed",
      });
    }
    return { close: closed };
  }

  async #remove(backend: DesktopBackend, name: string): Promise<void> {
    await this.#cli(backend, ["rm", "--force", name], { timeoutMs: 30_000 });
  }
}
