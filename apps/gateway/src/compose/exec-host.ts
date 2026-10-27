import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, type Stats, statSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type AgentToolRegistration, defineTool, type ToolRunContext } from "@psyche/agent-core";
import { defaultDenyRead } from "@psyche/mcp-host";
import type { FolderGrantEntry } from "@psyche/permissions";
import {
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_OUTPUT_CAP_BYTES,
  type PermissionBroker,
  PsycheError,
} from "@psyche/protocol";
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
 */

export const UNSANDBOXED_WORD = "UNSANDBOXED";
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
export function resolveExecutable(argv0: string, cwd: string): Resolved {
  const candidates = argv0.includes("/")
    ? [isAbsolute(argv0) ? argv0 : resolve(cwd, argv0)]
    : SAFE_PATH.map((d) => join(d, argv0));
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
        ]),
      ],
      allowRead: [],
      allowWrite: [input.scratch, ...input.writable],
      denyWrite: [input.psycheHome, h(".ssh"), h("Library", "Keychains")],
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

/** What the card shows and what an `always` grant binds (security §3.5, §5.4). */
function describe(p: HostParams) {
  const resolved = resolveExecutable(p.argv[0] as string, p.cwd);
  const env = envList(p.env ?? {});
  const domains = [...(p.allowedDomains ?? [])].sort();
  return { resolved, env, domains };
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
  return defineTool({
    name: "exec_host",
    description:
      "Run one command (an argv array, no shell string) on the owner's own Mac, in a folder they granted, for their own files and projects (build, test, git, scripts). Prefer `exec` (the sandbox container) whenever the work does not need the owner's real files. Every call asks the owner on their Mac, showing the exact argv, cwd, env and executable; it runs under srt (no secrets, no network unless `allowedDomains`). It is off until the owner turns it on: when a call is denied because it is off, or the cwd is outside granted folders, use request_permission with the `missing` object from the error, then retry.",
    input: Input,
    sideEffect: "destructive",
    provenanceOut: "untrusted",
    describeCall: (p) => {
      checkParams(p);
      const { resolved, env, domains } = describe(p);
      const srt = sandbox.known();
      const command = p.argv.join(" ");
      return {
        kind: "exec_host",
        target: { kind: "command", value: command.slice(0, 1000) },
        summary: `Run \`${command.slice(0, 80)}\` on this Mac`,
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
      const { real, folder } = await grantedFolder(p.cwd, deps.folders(ctx.threadId));
      // Hashed again right before it runs: a binary swapped after approval does not run.
      const { resolved, domains } = describe(p);
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
      const scratch = join(dir, `scratch-${id}`);
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      const settings = join(dir, `srt-${id}.json`);
      let user = "";
      try {
        user = userInfo().username;
      } catch {
        // No passwd entry; leave USER empty.
      }
      const env: NodeJS.ProcessEnv = {
        PATH: SAFE_PATH.join(":"),
        HOME: userHome,
        USER: user,
        LOGNAME: user,
        LANG: "en_US.UTF-8",
        TMPDIR: scratch,
        ...(p.env ?? {}),
      };
      let file = resolved.executable;
      let args = p.argv.slice(1);
      if (!unsandboxed && "path" in srt) {
        const profile = execHostSrtSettings({
          psycheHome: deps.home,
          userHome,
          scratch,
          writable: folder.mode === "rw" ? [folder.path] : [],
          allowedDomains: domains,
        });
        await writeFile(settings, JSON.stringify(profile), { mode: 0o600 });
        file = srt.path;
        args = ["--settings", settings, "--", resolved.executable, ...args];
      }
      const timeoutMs = p.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS;
      let timedOut = false;
      let stopped = false;
      const proc = driver.start(file, args, {
        cwd: real,
        env,
        maxBytes: EXEC_OUTPUT_CAP_BYTES,
        processGroup: true,
      });
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeoutMs);
      timer.unref();
      const onAbort = () => {
        stopped = true;
        proc.kill("SIGKILL");
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
      let result: CliResult;
      try {
        result = await proc.done;
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        await rm(settings, { force: true });
        await rm(scratch, { recursive: true, force: true });
        await rm(dirname(settings), { recursive: false, force: true }).catch(() => undefined);
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
        },
        provenance: "untrusted",
        ...(outcome === "ok" ? {} : { isError: true }),
      };
    },
  });
}
