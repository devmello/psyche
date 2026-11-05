import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, type Stats, statSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type AgentToolRegistration,
  defineTool,
  GIT_DRIVER_QUERY,
  gitDriverOverrides,
  type ToolRunContext,
} from "@psyche/agent-core";
import { createScratchDir, defaultDenyRead, scratchReadRules } from "@psyche/mcp-host";
import {
  classifyHostCommand,
  type FolderGrantEntry,
  READ_ONLY_RULE,
  SYSTEM_BIN_DIRS,
} from "@psyche/permissions";
import {
  type AuditLog,
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_OUTPUT_CAP_BYTES,
  type PermissionBroker,
  PsycheError,
  type ToolResult,
} from "@psyche/protocol";
import { hostWords } from "@psyche/protocol/host-words";
import { type CliDriver, type CliResult, nodeCliDriver } from "@psyche/sandbox";
import { Type } from "@sinclair/typebox";
import type { SrtResolver } from "./srt.ts";

/**
 * `exec_host`, "Run commands on this Mac" (security §5.4): one argv on the owner's own Mac, in a
 * folder the owner granted. Off by default (`exec.execHostEnabled`); every call asks on the Mac
 * (device-only), answered `once` or `always` bound to the exact argv, cwd, env subset and the
 * resolved executable's SHA-256 (30 days). A tainted turn is offered `once` only (§3.6).
 *
 * The command runs under srt with Psyche's deny profile (§5.3: the vault, state, audit, browser
 * profiles, `~/.ssh`, Keychains) and may write only to its granted folder (when that grant is
 * read-write) and a scratch directory. Only when the owner types `UNSANDBOXED` on the card does
 * one approved run go without srt; when srt is missing, that is the card's only way to run.
 * Bounded like `exec`: a timeout, 128 KB per stream, output masked with the vault's redactor,
 * the process group killed on Esc / Stop.
 *
 * Read-only commands (`classifyHostCommand`: `date`, `ls`, `cat`, `wc`…; never git) are a `read`:
 * the broker runs them without a card for an untainted owner turn outside `manual` mode
 * (`exec.readOnlyWithoutAsking`, on by default). They take the system binary only (SIP-protected
 * folders) and `PATH` limited to them, regular-file operands that stay inside the cwd after
 * symlinks, no env and no network, and run under srt with nothing writable but the scratch
 * directory, at most 15 s and two at a time, checked again right before the run. Each such run
 * is audited before it starts (`exec_host.read_only_run`) and when it ends (`….done`).
 */

export const UNSANDBOXED_WORD = "UNSANDBOXED";
/** A read-only command run without a card: at most this long, and this many at once. */
export const READ_ONLY_TIMEOUT_MS = 15_000;
export const READ_ONLY_CONCURRENCY = 2;

/**
 * Prefixed to every git that `exec_host` runs, carded or not (security §5.4): git runs programs
 * its config names, which an earlier write could have set. fsmonitor, hooks, the pager, an
 * external diff, signature display and gpg are off; `gitDriverOverrides` adds every filter, diff
 * and merge driver the repository's config defines. A side effect, and the safer default: an
 * approved `git commit` runs no hooks and cannot GPG-sign; the owner can in their own terminal.
 */
export const EXEC_HOST_GIT_HARDENING = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.pager=cat",
  "-c",
  "diff.external=",
  "-c",
  "log.showSignature=false",
  "-c",
  "gpg.program=/usr/bin/false",
  "-c",
  "gpg.ssh.program=/usr/bin/false",
  "-c",
  "gpg.x509.program=/usr/bin/false",
] as const;

function isGit(executable: string, argv0: string | undefined): boolean {
  return basename(executable) === "git" || (argv0 !== undefined && basename(argv0) === "git");
}

/** The `-c` pairs that switch off the drivers the repository's config defines (config only). */
function gitDriversOff(git: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  return new Promise((done) => {
    execFile(
      git,
      [...EXEC_HOST_GIT_HARDENING, ...GIT_DRIVER_QUERY],
      { cwd, env, timeout: 5_000, maxBuffer: 256 * 1024 },
      // Exit 1 means none are defined; stdout carries the names either way.
      (_err, stdout) => done(gitDriverOverrides(String(stdout ?? ""))),
    );
  });
}
const MAX_TIMEOUT_MS = 10 * 60_000;
const ENV_NAME = "^[A-Z][A-Z0-9_]{0,63}$";
/** Bare argv[0] is looked up here only, never in a PATH the agent supplies (CVE-2026-24763). */
export const SAFE_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];
/** Env names the agent may not set: they change what runs or where it loads code from. */
const RESERVED_ENV =
  /^(PATH|HOME|TMPDIR|SHELL|USER|LOGNAME|DYLD_.*|LD_.*|NODE_OPTIONS|BASH_ENV|ENV|PYTHONSTARTUP|PSYCHE_.*)$/;

/** Where srt is, or why it is not: the Gateway's one resolver (`compose/srt.ts`). */
export type SrtStatus = { path: string } | { missing: true; reason: string };
export type SrtLookup = Pick<SrtResolver, "resolve">;

/**
 * The last answer, for the card (`describeCall` is synchronous), refreshed on every look; a run
 * always waits for a fresh one.
 */
export function cachedSrt(resolver: SrtLookup): {
  known(): SrtStatus;
  fresh(): Promise<SrtStatus>;
} {
  let last: SrtStatus | undefined;
  const fresh = async () => {
    last = await resolver.resolve();
    return last;
  };
  void fresh().catch(() => undefined);
  return {
    known() {
      void fresh().catch(() => undefined);
      return last ?? { missing: true, reason: "the sandbox is still being checked" };
    },
    fresh,
  };
}

export interface ExecHostDeps {
  broker: Pick<PermissionBroker, "get">;
  vault: { redact(text: string): string };
  /** The live granted folders for a conversation (Settings plus this chat's Allow once). */
  folders(threadId: string): readonly FolderGrantEntry[];
  srt: SrtLookup;
  /** `$PSYCHE_HOME`: denied to the command; its settings and scratch live under it. */
  home: string;
  driver?: CliDriver;
  /** The owner's home folder (tests). */
  userHome?: string;
  /** Records each read-only run the broker let through without a card, before it starts. */
  audit?: Pick<AuditLog, "append">;
  /** Tests: a shorter cap than `READ_ONLY_TIMEOUT_MS`. */
  readOnlyTimeoutMs?: number;
}

interface Resolved {
  executable: string;
  sha256: string;
}

/** Per-binary hash cache keyed by inode, size and mtime, so a changed binary is hashed again. */
const hashes = new Map<string, { key: string; sha256: string }>();

function statKey(st: Stats): string {
  return `${st.ino}:${st.size}:${st.mtimeMs}`;
}

function sha256Of(path: string): string {
  const st = statSync(path);
  const key = statKey(st);
  const hit = hashes.get(path);
  if (hit?.key === key) return hit.sha256;
  const sha256 = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  hashes.set(path, { key, sha256 });
  return sha256;
}

/** argv[0] → the real file that runs: absolute, cwd-relative (`./x`), or from `SAFE_PATH`. */
export function resolveExecutable(
  argv0: string,
  cwd: string,
  path: readonly string[] = SAFE_PATH,
): Resolved {
  const candidates = argv0.includes("/")
    ? [isAbsolute(argv0) ? argv0 : resolve(cwd, argv0)]
    : path.map((d) => join(d, argv0));
  for (const c of candidates) {
    let real: string;
    try {
      real = realpathSync(c);
      if (!statSync(real).isFile()) continue;
      accessSync(real, constants.X_OK);
    } catch {
      continue;
    }
    return { executable: real, sha256: sha256Of(real) };
  }
  throw new PsycheError(
    "not_found",
    argv0.includes("/")
      ? `${argv0} is not an executable file`
      : `${argv0} is not in ${SAFE_PATH.join(":")}; give its absolute path`,
  );
}

/** Browser profiles beyond `defaultDenyRead`'s Chrome, Firefox and Safari. */
function browserProfiles(home: string): string[] {
  const s = (...p: string[]) => join(home, "Library", "Application Support", ...p);
  return [
    s("BraveSoftware"),
    s("Microsoft Edge"),
    s("Arc"),
    s("Chromium"),
    s("Vivaldi"),
    join(home, "Library", "Containers", "com.apple.Safari"),
  ];
}

/**
 * The srt profile of one host command (security §5.3): Psyche's deny-read list, writes only to
 * the scratch directory and a read-write granted folder, network only to `allowedDomains`
 * through srt's proxies, every documented escape hatch off.
 */
export function execHostSrtSettings(input: {
  psycheHome: string;
  userHome: string;
  scratch: string;
  writable: readonly string[];
  allowedDomains: readonly string[];
}): Record<string, unknown> {
  const h = (...p: string[]) => join(input.userHome, ...p);
  const scratch = scratchReadRules(input.psycheHome, input.scratch);
  return {
    filesystem: {
      denyRead: [
        ...new Set([
          // The MCP list is rooted at this process's home; re-rooted at the owner's.
          ...defaultDenyRead(input.psycheHome).map((p) =>
            p.startsWith(`${homedir()}/`) ? join(input.userHome, p.slice(homedir().length + 1)) : p,
          ),
          join(input.psycheHome, "vault"),
          join(input.psycheHome, "state"),
          join(input.psycheHome, "audit"),
          join(input.psycheHome, "browser", "profiles"),
          h(".ssh"),
          h("Library", "Keychains"),
          ...browserProfiles(input.userHome),
          ...scratch.denyRead,
        ]),
      ],
      allowRead: [...scratch.allowRead],
      allowWrite: [input.scratch, ...input.writable],
      denyWrite: [
        input.psycheHome,
        h(".ssh"),
        h("Library", "Keychains"),
        h("Library", "Application Support", "Psyche"),
      ],
    },
    network: {
      allowedDomains: [...input.allowedDomains],
      deniedDomains: [],
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
    enableWeakerNestedSandbox: false,
    allowNestedUserNamespaces: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
  };
}

function folderOf(
  path: string,
  folders: readonly FolderGrantEntry[],
): FolderGrantEntry | undefined {
  let best: FolderGrantEntry | undefined;
  for (const f of folders) {
    const root = f.path.length > 1 && f.path.endsWith("/") ? f.path.slice(0, -1) : f.path;
    if (path === root || path.startsWith(`${root}/`)) {
      if (best === undefined || root.length > best.path.length) best = { ...f, path: root };
      else if (root.length === best.path.length && f.mode === "rw") best = { ...f, path: root };
    }
  }
  return best;
}

/** A granted folder holding `cwd` after symlinks resolve; the error names what is missing. */
async function grantedFolder(
  cwd: string,
  folders: readonly FolderGrantEntry[],
): Promise<{ real: string; folder: FolderGrantEntry }> {
  let real: string;
  try {
    real = await realpath(cwd);
  } catch {
    throw new PsycheError("not_found", `${cwd} does not exist`);
  }
  const resolvedFolders = await Promise.all(
    folders.map(async (f) => ({ ...f, path: await realpath(f.path).catch(() => f.path) })),
  );
  const folder = folderOf(real, resolvedFolders);
  if (folder === undefined) {
    throw new PsycheError("forbidden", `${real} is outside every granted folder`, {
      details: { missing: { need: "folder", path: real, access: "read_write" } },
    });
  }
  return { real, folder };
}

function envList(env: Record<string, string>): string[] {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Read-only programs that read their operands' contents: those must be regular files. */
const READS_CONTENT = new Set(["cat", "head", "tail", "wc", "file"]);

/**
 * The read-only class with what needs the file system (security §5.4): Apple's binary from the
 * SIP-protected folders (never Homebrew's, which a same-user process could swap), and every file
 * operand inside the real cwd after symlinks. No operand is a FIFO, socket or device (a read
 * would hang or touch hardware); `cat`, `head`, `tail`, `wc` and `file` read regular files only.
 * A missing operand is checked by name: the command only fails on it, and the run checks again.
 */
export function readOnlyHost(p: HostParams): Resolved | undefined {
  if (Object.keys(p.env ?? {}).length > 0 || (p.allowedDomains ?? []).length > 0) return undefined;
  const c = classifyHostCommand(p.argv, p.cwd);
  if (!c.readOnly) return undefined;
  let cwd: string;
  let resolved: Resolved;
  try {
    cwd = realpathSync(p.cwd);
    resolved = resolveExecutable(c.program, p.cwd, SYSTEM_BIN_DIRS);
  } catch {
    return undefined;
  }
  if (!SYSTEM_BIN_DIRS.some((d) => under(resolved.executable, d))) return undefined;
  for (const operand of c.paths) {
    const abs = resolve(cwd, operand);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      real = abs;
    }
    if (!under(real, cwd)) return undefined;
    const st = statSync(real, { throwIfNoEntry: false });
    if (st !== undefined && !st.isFile() && (READS_CONTENT.has(c.program) || !st.isDirectory())) {
      return undefined;
    }
    // A hard link is one name for a file that may live outside the folder: realpath cannot tell.
    if (st?.isFile() === true && st.nlink > 1) return undefined;
  }
  return resolved;
}

/** What the card shows and what an `always` grant binds (security §3.5, §5.4). */
function describe(p: HostParams) {
  const readOnly = readOnlyHost(p);
  const resolved = readOnly ?? resolveExecutable(p.argv[0] as string, p.cwd);
  const env = envList(p.env ?? {});
  const domains = [...(p.allowedDomains ?? [])].sort();
  return { resolved, env, domains, readOnly: readOnly !== undefined };
}

const Input = Type.Object({
  argv: Type.Array(Type.String({ maxLength: 8192 }), { minItems: 1, maxItems: 256 }),
  cwd: Type.String({
    minLength: 1,
    maxLength: 1024,
    description: "Absolute folder to run in; it must be inside a folder the owner granted",
  }),
  env: Type.Optional(
    Type.Record(Type.String({ pattern: ENV_NAME }), Type.String({ maxLength: 8192 }), {
      description:
        "Extra environment; shown on the card. PATH, HOME and loader variables are fixed",
    }),
  ),
  allowedDomains: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 253, pattern: "^[A-Za-z0-9.*-]+$" }), {
      maxItems: 32,
      description: "Hosts the command may reach (npm, git); none by default",
    }),
  ),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS })),
});
type HostParams = {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  allowedDomains?: string[];
  timeoutMs?: number;
};

function checkParams(p: HostParams): void {
  if (!isAbsolute(p.cwd)) throw new PsycheError("invalid_params", "cwd must be an absolute path");
  for (const [k, v] of Object.entries(p.env ?? {})) {
    if (RESERVED_ENV.test(k)) throw new PsycheError("invalid_params", `env ${k} is fixed`);
    // Host commands get no vault secrets: placeholders stay a container (`exec`) feature.
    if (v.includes("{{cred:")) {
      throw new PsycheError("invalid_params", `env ${k}: no vault placeholders on the host`);
    }
  }
}

/** Was this run approved with `UNSANDBOXED` typed on its card (once only, never a grant)? */
async function approvedUnsandboxed(
  deps: ExecHostDeps,
  ctx: ToolRunContext,
  sha256: string,
): Promise<boolean> {
  if (ctx.approvalId === undefined) {
    // A standing `always` grant: bound to the binary hash, never unsandboxed.
    const key = ctx.authority?.grantKey;
    if (key !== undefined && !key.includes(sha256)) {
      throw new PsycheError("binding_mismatch", "the executable changed since it was approved");
    }
    return false;
  }
  const a = await deps.broker.get(ctx.approvalId);
  const details = (a?.details ?? {}) as { executableSha256?: unknown; unsandboxed?: unknown };
  if (details.executableSha256 !== sha256) {
    throw new PsycheError("binding_mismatch", "the executable changed since it was approved");
  }
  return details.unsandboxed === true && a?.scopeGranted === "once";
}

export function execHostTool(deps: ExecHostDeps): AgentToolRegistration {
  const driver = deps.driver ?? nodeCliDriver;
  const userHome = deps.userHome ?? homedir();
  const sandbox = cachedSrt(deps.srt);
  /** Read-only runs without a card in flight now (`READ_ONLY_CONCURRENCY`). */
  let quietRunning = 0;
  return defineTool({
    name: "exec_host",
    description:
      "Run one command (an argv array, no shell string) on the owner's own computer, in a folder they granted, for their own files and projects (build, test, git, scripts). Prefer `exec` (the sandbox container) whenever the work does not need the owner's real files. Calls ask the owner on their Mac, showing the exact argv, cwd, env and executable; read-only commands (date, pwd, whoami, uname, ls, cat, head, tail, wc, file, stat, which on files in the cwd) with no env and no allowedDomains run without asking unless the turn read untrusted content; git and everything else asks. It runs under srt (no secrets, no network unless `allowedDomains`). It is off until the owner turns it on: when a call is denied because it is off, or the cwd is outside granted folders, use request_permission with the `missing` object from the error, then retry.",
    input: Input,
    // The broker lowers a call to `read` only when it re-checks the read-only class itself
    // (`describeCall` names it in `meta`); the tool as such stays `destructive`.
    sideEffect: "destructive",
    provenanceOut: "untrusted",
    describeCall: (p) => {
      checkParams(p);
      const described = describe(p);
      const { resolved, env, domains } = described;
      // No audit log, no quiet path: the run must be recorded before it starts.
      const readOnly = described.readOnly && deps.audit !== undefined;
      const srt = sandbox.known();
      const command = p.argv.join(" ");
      // Without srt nothing runs without a card (the sandbox is what keeps it read-only); the card
      // still reads as a read.
      return {
        kind: "exec_host",
        ...(readOnly
          ? {
              meta: {
                hostCommand: "read_only" as const,
                ...("missing" in srt ? { hostSandbox: "missing" as const } : {}),
              },
            }
          : {}),
        target: { kind: "command", value: command.slice(0, 1000) },
        summary: `Run \`${command.slice(0, 80)}\` on ${hostWords().thisDevice}`,
        details: {
          argv: p.argv,
          cwd: p.cwd,
          env,
          executable: resolved.executable,
          executableSha256: resolved.sha256,
          allowedDomains: domains,
          sandbox: "path" in srt ? "srt" : "missing",
          ...("missing" in srt ? { sandboxMissingReason: srt.reason } : {}),
          unsandboxedWord: UNSANDBOXED_WORD,
          ...(readOnly ? { readOnly: true } : {}),
        },
        // Security §3.5 exec_host fields: exact argv, cwd, env subset, binary and its hash.
        bindingFields: {
          argv: p.argv,
          cwd: p.cwd,
          env: { ...(p.env ?? {}) },
          executable: resolved.executable,
          executableSha256: resolved.sha256,
          network: domains.length === 0 ? "none" : "proxy",
        },
        grantKey: `exec_host|${JSON.stringify([p.argv, p.cwd, env, resolved.executable, resolved.sha256, domains])}`,
      };
    },
    async run(p, ctx) {
      checkParams(p);
      // A quiet run takes its slot before the first await, so runs racing through the checks
      // never make a third; every exit releases it.
      const quiet = ctx.approvalId === undefined && ctx.authority?.rule === READ_ONLY_RULE;
      if (quiet) {
        if (quietRunning >= READ_ONLY_CONCURRENCY) {
          throw new PsycheError(
            "unavailable",
            `${READ_ONLY_CONCURRENCY} read-only commands are already running; try again when one finishes`,
            { retryable: true },
          );
        }
        quietRunning++;
      }
      try {
        return await runHost(p, ctx, quiet);
      } finally {
        if (quiet) quietRunning--;
      }
    },
  });

  async function runHost(p: HostParams, ctx: ToolRunContext, quiet: boolean): Promise<ToolResult> {
    const { real, folder } = await grantedFolder(p.cwd, deps.folders(ctx.threadId));
    // Hashed again right before it runs: a binary swapped after approval does not run.
    const described = describe(p);
    const { resolved, domains } = described;
    const readOnly = described.readOnly;
    if (quiet && deps.audit === undefined) {
      throw new PsycheError("forbidden", "Read-only commands run without a card only when audited");
    }
    if (quiet && !readOnly) {
      throw new PsycheError(
        "forbidden",
        "This command is no longer read-only (a file operand leaves the folder or the binary changed); it was not run",
      );
    }
    const unsandboxed = await approvedUnsandboxed(deps, ctx, resolved.sha256);
    const srt = await sandbox.fresh();
    if (!unsandboxed && "missing" in srt) {
      throw new PsycheError(
        "unavailable",
        `${srt.reason}: set up the sandbox (request_permission with {"need": "sandbox"}), or the owner types ${UNSANDBOXED_WORD} on the card`,
        { details: { missing: { need: "sandbox" } } },
      );
    }
    if (unsandboxed && folder.mode !== "rw") {
      throw new PsycheError(
        "forbidden",
        `${folder.path} is granted read-only; an unsandboxed command needs a read-write folder`,
        { details: { missing: { need: "folder", path: folder.path, access: "read_write" } } },
      );
    }
    const dir = join(deps.home, "exec-host");
    const id = randomUUID();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Short on purpose: srt's mux sockets live in it and `sun_path` is 104 bytes.
    const scratch = await createScratchDir(dir);
    const settings = join(dir, `srt-${id}.json`);
    const cleanup = async () => {
      await rm(settings, { force: true });
      await rm(scratch, { recursive: true, force: true });
      await rm(dirname(settings), { recursive: false, force: true }).catch(() => undefined);
    };
    let user = "";
    try {
      user = userInfo().username;
    } catch {
      // No passwd entry; leave USER empty.
    }
    const env: NodeJS.ProcessEnv = {
      // A read-only command finds only Apple's programs (no Homebrew helper it might call).
      PATH: (readOnly ? SYSTEM_BIN_DIRS : SAFE_PATH).join(":"),
      HOME: userHome,
      USER: user,
      LOGNAME: user,
      LANG: "en_US.UTF-8",
      TMPDIR: scratch,
      ...(p.env ?? {}),
    };
    let file = resolved.executable;
    let args = p.argv.slice(1);
    // Every git, carded or not: no program its config names (security §5.4).
    if (isGit(resolved.executable, p.argv[0])) {
      args = [
        ...EXEC_HOST_GIT_HARDENING,
        ...(await gitDriversOff(resolved.executable, real, env)),
        ...args,
      ];
    }
    if (!unsandboxed && "path" in srt) {
      const profile = execHostSrtSettings({
        psycheHome: deps.home,
        userHome,
        scratch,
        // Read-only: nothing writable but the scratch directory, whatever the folder's grant.
        writable: folder.mode === "rw" && !readOnly ? [folder.path] : [],
        allowedDomains: readOnly ? [] : domains,
      });
      await writeFile(settings, JSON.stringify(profile), { mode: 0o600 });
      file = srt.path;
      args = ["--settings", settings, "--", resolved.executable, ...args];
    }
    const cap = deps.readOnlyTimeoutMs ?? READ_ONLY_TIMEOUT_MS;
    const timeoutMs = quiet
      ? Math.min(p.timeoutMs ?? cap, cap)
      : (p.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS);
    let timedOut = false;
    let stopped = false;
    if (quiet) {
      // Recorded before it starts: a run the audit log cannot record does not run.
      try {
        await deps.audit?.append({
          kind: "exec_host.read_only_run",
          actor: { type: "agent", runId: ctx.runId },
          subject: { runId: ctx.runId, threadId: ctx.threadId },
          data: {
            runKey: id,
            argv: p.argv,
            cwd: real,
            executable: resolved.executable,
            executableSha256: resolved.sha256,
          },
        });
      } catch {
        await cleanup();
        throw new PsycheError(
          "unavailable",
          "The audit log could not record this read-only command, so it was not run",
        );
      }
    }
    let result: CliResult | undefined;
    let auditFailed = false;
    let timer: NodeJS.Timeout | undefined;
    let kill: (() => void) | undefined;
    const onAbort = () => {
      stopped = true;
      kill?.();
    };
    try {
      // Inside the try: a start that throws still releases everything and records the end.
      const proc = driver.start(file, args, {
        cwd: real,
        env,
        maxBytes: EXEC_OUTPUT_CAP_BYTES,
        processGroup: true,
      });
      kill = () => proc.kill("SIGKILL");
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeoutMs);
      timer.unref();
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
      result = await proc.done;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      await cleanup();
      if (quiet) {
        // The run's end, whatever happened; a failure to record it is reported, not dropped.
        try {
          await deps.audit?.append({
            kind: "exec_host.read_only_run.done",
            actor: { type: "agent", runId: ctx.runId },
            subject: { runId: ctx.runId, threadId: ctx.threadId },
            data: {
              runKey: id,
              exitCode: result?.exitCode ?? null,
              outcome:
                result === undefined
                  ? "error"
                  : timedOut || stopped
                    ? "uncertain"
                    : result.exitCode === 0
                      ? "ok"
                      : "failed",
              timedOut,
            },
          });
        } catch {
          auditFailed = true;
        }
      }
    }
    const redact = (b: Buffer) => deps.vault.redact(b.toString("utf8"));
    // An interrupted host command may have done part of its work: uncertain, never replayed.
    const outcome = timedOut || stopped ? "uncertain" : result.exitCode === 0 ? "ok" : "failed";
    return {
      output: {
        exitCode: result.exitCode,
        stdout: redact(result.stdout),
        stderr: redact(result.stderr),
        durationMs: result.durationMs,
        truncated: result.stdoutTruncated || result.stderrTruncated,
        timedOut,
        ...(stopped ? { stopped: true } : {}),
        sandboxed: !unsandboxed,
        executable: resolved.executable,
        cwd: real,
        outcome,
        ...(auditFailed ? { auditFailed: true } : {}),
      },
      provenance: "untrusted",
      ...(outcome === "ok" && !auditFailed ? {} : { isError: true }),
    };
  }
}
