import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import { getDevice } from "@psyche/db";
import {
  type EventPayload,
  PsycheError,
  TERMINAL_OUTPUT_WINDOW,
  TERMINAL_WRITE_MAX_BYTES,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { requireFreshPresence } from "../presence-gate.ts";
import type { Gateway } from "../server.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * A terminal running on the Host (remote-gateway design §4.2, R4): `terminal.session.*`.
 *
 * The Gateway spawns the owner's login shell in a PTY on the machine it runs on and streams the
 * output to the device that opened it (`terminal.output`, flow-controlled by `terminal.session.ack`)
 * while keystrokes come back through `terminal.session.write`. The client never runs anything
 * and never chooses what runs: the shell is the Host user's own (from the OS user database), the
 * environment is a short fixed list (never the Gateway's own, which holds the handshake secret
 * and key paths), and the only client input is a folder, the window size and keystrokes.
 *
 * Authorization is the point of this module:
 *  - `operator.admin` (the method table; admin is opt-in per device);
 *  - fresh presence at open: with a presence verifier registered, the owner approves a
 *    device-only card with Touch ID or a passkey (`requireFreshPresence`); with none, only the
 *    desktop shell on the Host itself may open one, and everyone else is told to open it on the
 *    Host. `HostTerminalOptions.presence` is where a client-presence verifier plugs in;
 *  - a session belongs to the device that opened it: any other device gets `not_found` for every
 *    call, never `forbidden`, so session ids reveal nothing;
 *  - sessions die when the device has been gone for `disconnectGraceMs`, at once when it was
 *    revoked or lost admin (checked on disconnect and by a sweep), and when the Gateway stops;
 *  - at most `maxSessionsPerDevice` (and `maxSessions` in all) at a time;
 *  - the audit log gets `terminal.session.open` and `terminal.session.close` (who, which folder,
 *    why it ended, how many characters moved); terminal contents never leave the PTY path.
 */

export interface PtyDisposable {
  dispose(): void;
}

/** The slice of node-pty's `IPty` this module uses; tests pass a fake. */
export interface PtyProcess {
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  /** Stop reading the PTY (the kernel buffer then fills and the shell blocks). Optional. */
  pause?(): void;
  resume?(): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

/** What the Host runs for a session. */
export interface HostTarget {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  label: string;
}

export interface TargetSource {
  home: string;
  /** The Host user's shell from the OS user database; absent when it has none (always on Windows). */
  userShell: string | undefined;
  env: NodeJS.ProcessEnv;
  user: string;
  /** Defaults to this process's platform. */
  platform?: NodeJS.Platform;
}

export interface HostTerminalLimits {
  maxSessionsPerDevice: number;
  maxSessions: number;
  /** How long a session outlives its device's last connection. */
  disconnectGraceMs: number;
  /** Output characters sent before an `ack` is needed. */
  outputWindow: number;
  /** Characters per `terminal.output` event. */
  chunkChars: number;
  /** Output held while the client is behind, per session; the oldest is dropped beyond it. */
  maxPendingChars: number;
  /** Output is batched this long before it is sent (0: at once). */
  flushMs: number;
  /** How often sessions re-check that their device is still paired and admin. */
  sweepMs: number;
  /** Input budget per session: a burst, and a refill rate in bytes per second. */
  writeBurstBytes: number;
  writeBytesPerSecond: number;
  /** Calls per session (write, resize, ack alike): a burst, and a refill rate per second. */
  callBurst: number;
  callsPerSecond: number;
  /** Resizes per session: a burst, and a refill rate per second. */
  resizeBurst: number;
  resizesPerSecond: number;
  /** A session with no call (write, resize, ack) for this long is closed. */
  idleTimeoutMs: number;
  /** Output waits while the owner's socket has this many bytes queued. */
  socketBacklogBytes: number;
  /** Longest the folder check may take (a hung network mount). */
  cwdTimeoutMs: number;
}

export const DEFAULT_HOST_TERMINAL_LIMITS: HostTerminalLimits = {
  maxSessionsPerDevice: 4,
  maxSessions: 8,
  disconnectGraceMs: 30_000,
  outputWindow: TERMINAL_OUTPUT_WINDOW,
  chunkChars: 32 * 1024,
  maxPendingChars: 2 * TERMINAL_OUTPUT_WINDOW,
  flushMs: 8,
  sweepMs: 5_000,
  writeBurstBytes: 1024 * 1024,
  writeBytesPerSecond: 512 * 1024,
  callBurst: 600,
  callsPerSecond: 300,
  resizeBurst: 20,
  resizesPerSecond: 5,
  idleTimeoutMs: 30 * 60_000,
  socketBacklogBytes: 1024 * 1024,
  cwdTimeoutMs: 2_000,
};

/**
 * Decides whether this call may open a Host shell. Throws to refuse (`approval_required` for
 * the card the owner must answer first). A client-presence verifier (passkeys) replaces the
 * default here without touching the rest.
 */
export interface HostTerminalPresence {
  check(
    call: Call,
    input: { approvalId: string | undefined; cwd: string | undefined },
  ): Promise<void>;
}

/** Fixed, never the Gateway's own PATH (a LaunchAgent's is whatever launchd gave it). */
/**
 * Windows: the shells to try after an explicit one, by absolute path: PowerShell 7, Windows
 * PowerShell 5.1 (always present), then `cmd.exe`.
 */
function windowsShells(env: NodeJS.ProcessEnv): string[] {
  const root = envValue(env, "SystemRoot") ?? "C:\\Windows";
  const programFiles = envValue(env, "ProgramFiles") ?? "C:\\Program Files";
  return [
    join(programFiles, "PowerShell", "7", "pwsh.exe"),
    join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    envValue(env, "ComSpec") ?? join(root, "System32", "cmd.exe"),
  ];
}

/** Windows environment names are case-insensitive (`Path` and `PATH` are one variable). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key === undefined ? undefined : env[key];
  return v !== undefined && v !== "" && !hasNul(v) ? v : undefined;
}

/**
 * The Windows variables a shell and the tools in it need to work (profile folders, the system
 * root, `PATHEXT`, the user's `PATH`), copied from the Host's own environment; nothing else is
 * inherited, so no Psyche secret reaches the shell.
 */
const WINDOWS_ENV_KEYS = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "Path",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "PUBLIC",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
] as const;

function shellArgs(shell: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return ["-l"];
  const name = basename(shell).toLowerCase();
  if (name === "cmd.exe") return [];
  if (name === "pwsh.exe" || name === "powershell.exe") return ["-NoLogo"];
  return ["-l"]; // a POSIX shell the owner chose (Git Bash, MSYS2)
}

function systemPath(): string {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"].filter((d) => existsSync(d));
  return [...extra, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

export interface HostTerminalOptions {
  /** Defaults to node-pty, loaded on first use. */
  spawn?: PtySpawn;
  presence?: HostTerminalPresence;
  limits?: Partial<HostTerminalLimits>;
  /** The computer's name for messages; defaults to the OS host name. */
  hostName?: () => string;
  /** Where the shell, home and environment come from; tests point it at a temp directory. */
  target?: () => TargetSource;
  now?: () => number;
}

export type ExitReason = EventPayload<"terminal.exit">["reason"];

const MAX_PATH = 4096;

function hasNul(s: string): boolean {
  return s.includes("\0");
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function systemTargetSource(): TargetSource {
  let userShell: string | undefined;
  let user = "";
  try {
    const info = userInfo();
    userShell = info.shell ?? undefined;
    user = info.username;
  } catch {
    // no passwd entry: fall back below
  }
  return { home: homedir(), userShell, env: process.env, user };
}

/**
 * The Host shell and where it starts. Pure but for the file checks. The shell is the user's own
 * (then the usual system ones); the folder must be an existing absolute directory. The
 * environment is built from scratch.
 */
export async function resolveHostTarget(
  source: TargetSource,
  host: string,
  cwd: string | undefined,
  cwdTimeoutMs = 2_000,
): Promise<HostTarget> {
  const platform = source.platform ?? process.platform;
  const win = platform === "win32";
  const candidates = win
    ? [source.userShell, ...windowsShells(source.env)]
    : [source.userShell, "/bin/zsh", "/bin/bash", "/bin/sh"];
  const shell = candidates.find(
    (s): s is string => typeof s === "string" && isAbsolute(s) && !hasNul(s) && isExecutable(s),
  );
  if (shell === undefined) {
    throw new PsycheError("unavailable", `${host} has no shell Psyche can start`);
  }
  let dir = source.home;
  if (cwd !== undefined) {
    if (!isAbsolute(cwd) || hasNul(cwd) || cwd.length > MAX_PATH) {
      throw new PsycheError("invalid_params", "cwd must be an absolute folder on the Host");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      dir = await Promise.race([
        (async () => {
          const real = await realpath(cwd);
          if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
          return real;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), cwdTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      throw new PsycheError("invalid_params", `That folder doesn't exist on ${host}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  const lang = source.env.LANG;
  const env: Record<string, string> = win
    ? windowsEnv(source)
    : {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: lang && !hasNul(lang) ? lang : "en_US.UTF-8",
        PATH: systemPath(),
        TMPDIR: tmpdir(),
        HOME: source.home,
        SHELL: shell,
        ...(source.user && !hasNul(source.user) ? { USER: source.user, LOGNAME: source.user } : {}),
      };
  const slash = win ? sep : "/";
  let shown = dir;
  if (dir === source.home) shown = "~";
  else if (dir.startsWith(`${source.home}${slash}`)) shown = `~${dir.slice(source.home.length)}`;
  return {
    file: shell,
    args: shellArgs(shell, platform),
    cwd: dir,
    env,
    label: `${basename(shell)} · ${shown}`,
  };
}

function windowsEnv(source: TargetSource): Record<string, string> {
  const env: Record<string, string> = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TEMP: tmpdir(),
    TMP: tmpdir(),
    HOME: source.home,
  };
  for (const key of WINDOWS_ENV_KEYS) {
    const v = envValue(source.env, key);
    if (v !== undefined) env[key] = v;
  }
  if (env.Path === undefined) {
    const root = env.SystemRoot ?? "C:\\Windows";
    env.Path = [
      join(root, "System32"),
      root,
      join(root, "System32", "WindowsPowerShell", "v1.0"),
    ].join(";");
  }
  return env;
}

async function loadNodePty(): Promise<PtySpawn> {
  const mod = (await import("node-pty")) as unknown as {
    spawn?: typeof import("node-pty").spawn;
    default?: { spawn?: typeof import("node-pty").spawn };
  };
  const spawn = mod.spawn ?? mod.default?.spawn;
  if (spawn === undefined) throw new Error("node-pty has no spawn");
  return (file, args, options) => spawn(file, args, options);
}

interface Bucket {
  tokens: number;
  at: number;
}

interface Session {
  id: string;
  deviceId: string;
  pty: PtyProcess;
  startedAt: number;
  /** The last call from the owner (write, resize, ack); the idle timeout counts from it. */
  lastActivity: number;
  /** Output held back (the client is behind, or the device is away). */
  pending: string[];
  pendingChars: number;
  /** Characters sent / confirmed. `end` in events and acks counts these. */
  sent: number;
  acked: number;
  paused: boolean;
  /** The device has no open connection: output is held, nothing is sent. */
  detached: boolean;
  exited: { exitCode: number } | undefined;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  subscriptions: PtyDisposable[];
  /** Budgets: input bytes, calls of any kind, resizes. */
  input: Bucket;
  calls: Bucket;
  resizes: Bucket;
  inputChars: number;
  droppedChars: number;
}

/** Refills a bucket and takes `cost`; false when it holds less. */
function take(b: Bucket, cost: number, burst: number, perSecond: number, t: number): boolean {
  b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSecond);
  b.at = t;
  if (cost > b.tokens) return false;
  b.tokens -= cost;
  return true;
}

export function hostTerminalPart(opts: HostTerminalOptions = {}) {
  return (services: ComposeServices): ComposedPart => {
    const limits: HostTerminalLimits = { ...DEFAULT_HOST_TERMINAL_LIMITS, ...opts.limits };
    const now = opts.now ?? Date.now;
    const hostName = opts.hostName ?? hostname;
    const targetSource = opts.target ?? systemTargetSource;
    const sessions = new Map<string, Session>();
    const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let spawn: PtySpawn | undefined = opts.spawn;
    let gateway: Gateway | null = null;
    let sweep: ReturnType<typeof setInterval> | undefined;
    let pendingOpens = 0;

    const log = (
      level: "info" | "warn",
      message: string,
      fields: Record<string, string | number | boolean | null>,
    ) => services.logger?.log(level, message, fields);

    type AuditData = Record<string, string | number | null>;
    const auditActor = (deviceId: string) => ({ type: "device" as const, deviceId });
    /** Best effort (closes, refusals): a failed write is logged, not fatal. */
    const audit = (kind: string, deviceId: string, data: AuditData) => {
      services.audit
        .append({ kind, actor: auditActor(deviceId), data })
        .catch((err: unknown) =>
          log("warn", "terminal audit append failed", { code: PsycheError.from(err).code }),
        );
    };

    const presence: HostTerminalPresence = opts.presence ?? defaultPresence(hostName);

    const connectionsOf = (deviceId: string) =>
      [...(gateway?.context.connections() ?? [])].filter(
        (c) => c.open && c.identity?.deviceId === deviceId,
      );
    const deviceOnline = (deviceId: string): boolean => connectionsOf(deviceId).length > 0;
    /** The owner's socket has a pile of unsent bytes: stop adding to it. */
    const backlogged = (deviceId: string): boolean =>
      connectionsOf(deviceId).some((c) => c.bufferedAmount() > limits.socketBacklogBytes);

    /** Ends a session once: the shell dies, the client hears why, the audit log records it. */
    const finish = (s: Session, reason: ExitReason, exitCode: number | null) => {
      if (sessions.get(s.id) !== s) return;
      sessions.delete(s.id);
      if (s.flushTimer !== undefined) clearTimeout(s.flushTimer);
      s.flushTimer = undefined;
      for (const sub of s.subscriptions) sub.dispose();
      s.subscriptions = [];
      s.pending = [];
      s.pendingChars = 0;
      if (s.exited === undefined) {
        try {
          s.pty.kill();
        } catch {
          // already gone
        }
      }
      gateway?.bus.publishToDevice(s.deviceId, "terminal.exit", {
        sessionId: s.id,
        exitCode,
        reason,
      });
      audit("terminal.session.close", s.deviceId, {
        sessionId: s.id,
        reason,
        exitCode,
        durationMs: Math.max(0, now() - s.startedAt),
        outputChars: s.sent,
        inputChars: s.inputChars,
        droppedChars: s.droppedChars,
      });
    };

    const killDevice = (deviceId: string, reason: ExitReason) => {
      for (const s of [...sessions.values()]) if (s.deviceId === deviceId) finish(s, reason, null);
    };

    /** Sends what the window and the socket allow; pauses the PTY while the client is behind. */
    const drain = (s: Session) => {
      if (sessions.get(s.id) !== s) return;
      let jammed = false;
      while (!s.detached && s.pendingChars > 0 && s.sent - s.acked < limits.outputWindow) {
        if (backlogged(s.deviceId)) {
          jammed = true;
          break;
        }
        const room = Math.min(limits.chunkChars, limits.outputWindow - (s.sent - s.acked));
        const all = s.pending.length === 1 ? (s.pending[0] ?? "") : s.pending.join("");
        let n = Math.min(room, all.length);
        // Never split a surrogate pair across events.
        const last = all.charCodeAt(n - 1);
        if (n < all.length && last >= 0xd800 && last <= 0xdbff) n -= 1;
        if (n <= 0) break;
        const rest = all.slice(n);
        s.pending = rest.length > 0 ? [rest] : [];
        s.pendingChars = rest.length;
        s.sent += n;
        gateway?.bus.publishToDevice(s.deviceId, "terminal.output", {
          sessionId: s.id,
          data: all.slice(0, n),
          end: s.sent,
        });
      }
      if (jammed && s.flushTimer === undefined) {
        // No ack will announce that the socket drained: look again shortly.
        s.flushTimer = setTimeout(() => {
          s.flushTimer = undefined;
          drain(s);
        }, 50);
        s.flushTimer.unref?.();
      }
      const behind = s.detached || s.sent - s.acked >= limits.outputWindow || s.pendingChars > 0;
      if (behind && !s.paused) {
        s.paused = true;
        try {
          s.pty.pause?.();
        } catch {
          // a PTY that cannot pause is bounded by maxPendingChars instead
        }
      } else if (!behind && s.paused) {
        s.paused = false;
        try {
          s.pty.resume?.();
        } catch {
          // gone
        }
      }
      if (s.exited !== undefined && s.pendingChars === 0 && !s.detached) {
        finish(s, "exited", s.exited.exitCode);
      }
    };

    const onData = (s: Session, data: string) => {
      if (sessions.get(s.id) !== s || data.length === 0) return;
      s.pending.push(data);
      s.pendingChars += data.length;
      if (s.pendingChars > limits.maxPendingChars) {
        // The client is far behind and the PTY kept talking: keep the newest output.
        const all = s.pending.join("");
        const drop = all.length - limits.maxPendingChars;
        s.droppedChars += drop;
        s.pending = [all.slice(drop)];
        s.pendingChars = limits.maxPendingChars;
      }
      if (s.paused || s.detached) return;
      if (limits.flushMs <= 0 || s.pendingChars >= limits.chunkChars) {
        drain(s);
      } else if (s.flushTimer === undefined) {
        s.flushTimer = setTimeout(() => {
          s.flushTimer = undefined;
          drain(s);
        }, limits.flushMs);
        s.flushTimer.unref?.();
      }
    };

    const onExit = (s: Session, exitCode: number) => {
      if (sessions.get(s.id) !== s) return;
      s.exited = { exitCode };
      if (s.flushTimer !== undefined) clearTimeout(s.flushTimer);
      s.flushTimer = undefined;
      drain(s);
    };

    /** The owner device is talking again: keep its sessions and carry on from now. */
    const attach = (s: Session) => {
      const timer = graceTimers.get(s.deviceId);
      if (timer !== undefined) {
        clearTimeout(timer);
        graceTimers.delete(s.deviceId);
      }
      if (s.detached) {
        s.detached = false;
        // What was in flight to the old connection is lost; count it as seen.
        s.acked = s.sent;
        drain(s);
      }
    };

    /**
     * The owner's session for a call, charged to its budgets. Another device's session is
     * indistinguishable from a missing one.
     */
    const owned = (call: Call, sessionId: string, kind: "write" | "resize" | "ack"): Session => {
      const s = sessions.get(sessionId);
      if (s === undefined || s.deviceId !== call.identity.deviceId) {
        throw new PsycheError("not_found", "There is no such terminal session");
      }
      const t = now();
      const tooMany =
        !take(s.calls, 1, limits.callBurst, limits.callsPerSecond, t) ||
        (kind === "resize" && !take(s.resizes, 1, limits.resizeBurst, limits.resizesPerSecond, t));
      if (tooMany) {
        throw new PsycheError("rate_limited", "Too many terminal calls; slow down", {
          retryable: true,
        });
      }
      s.lastActivity = t;
      attach(s);
      return s;
    };

    const stillAllowed = (deviceId: string): boolean => {
      const d = getDevice(services.db, deviceId);
      return (
        d !== undefined &&
        d !== null &&
        d.pairedAt !== null &&
        d.revokedAt === null &&
        d.scopes.includes("operator.admin")
      );
    };

    /**
     * The device has no connection: hold its output and start the grace clock. When it runs
     * out, every session of the device that never spoke again is killed, online or not.
     */
    const detachDevice = (deviceId: string) => {
      const mine = [...sessions.values()].filter((s) => s.deviceId === deviceId);
      if (mine.length === 0) return;
      if (!stillAllowed(deviceId)) {
        killDevice(deviceId, "device_revoked");
        return;
      }
      for (const s of mine) {
        s.detached = true;
        if (s.flushTimer !== undefined) clearTimeout(s.flushTimer);
        s.flushTimer = undefined;
        drain(s);
      }
      const prior = graceTimers.get(deviceId);
      if (prior !== undefined) clearTimeout(prior);
      const timer = setTimeout(() => {
        graceTimers.delete(deviceId);
        for (const s of [...sessions.values()]) {
          if (s.deviceId === deviceId && s.detached) finish(s, "device_disconnected", null);
        }
      }, limits.disconnectGraceMs);
      timer.unref?.();
      graceTimers.set(deviceId, timer);
    };

    const checkCaps = (deviceId: string, host: string) => {
      const mine = [...sessions.values()].filter((s) => s.deviceId === deviceId).length;
      if (
        mine + pendingOpens >= limits.maxSessionsPerDevice ||
        sessions.size + pendingOpens >= limits.maxSessions
      ) {
        throw new PsycheError(
          "rate_limited",
          `Too many terminals are open on ${host}. Close one to open another.`,
          { details: { reason: "terminal_limit", limit: limits.maxSessionsPerDevice } },
        );
      }
    };

    const handlers: Record<string, HandlerDef> = {
      "terminal.session.open": {
        async run(
          call: Call,
          params: { cols: number; rows: number; cwd?: string; approvalId?: string },
        ) {
          const host = hostName();
          const deviceId = call.identity.deviceId;
          const where: AuditData = {
            peerAddress: call.conn.peer.remoteAddress,
            transport: call.conn.peer.transport,
          };
          /** A refused open is recorded too (the approval card step is not a refusal). */
          const refused = (err: unknown): never => {
            const e = PsycheError.from(err);
            if (e.code !== "approval_required") {
              audit("terminal.session.refused", deviceId, {
                code: e.code,
                ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
                ...where,
              });
            }
            throw e;
          };
          // Caps before presence: a refused open must not spend the owner's approval.
          try {
            checkCaps(deviceId, host);
            // Presence before anything about the Host (folders, shells) is revealed.
            await presence.check(call, { approvalId: params.approvalId, cwd: params.cwd });
            // Again: another open may have taken the last place while the owner approved.
            checkCaps(deviceId, host);
          } catch (err) {
            return refused(err);
          }
          pendingOpens += 1;
          try {
            let target: HostTarget;
            try {
              target = await resolveHostTarget(
                targetSource(),
                host,
                params.cwd,
                limits.cwdTimeoutMs,
              );
            } catch (err) {
              return refused(err);
            }
            const id = `term_${randomUUID()}`;
            // Fail closed: no shell without the record of who opened it.
            try {
              await services.audit.append({
                kind: "terminal.session.open",
                actor: auditActor(deviceId),
                data: {
                  sessionId: id,
                  cwd: target.cwd,
                  shell: target.file,
                  desktopShell: call.identity.desktopShell === true ? 1 : 0,
                  approvalId: params.approvalId ?? null,
                  ...where,
                },
              });
            } catch (err) {
              log("warn", "terminal audit append failed", { code: PsycheError.from(err).code });
              throw new PsycheError("unavailable", `${host} could not record the terminal`);
            }
            let pty: PtyProcess;
            try {
              spawn ??= await loadNodePty();
              pty = spawn(target.file, target.args, {
                name: "xterm-256color",
                cols: params.cols,
                rows: params.rows,
                cwd: target.cwd,
                env: target.env,
              });
            } catch (err) {
              log("warn", "terminal spawn failed", { code: PsycheError.from(err).code });
              audit("terminal.session.close", deviceId, { sessionId: id, reason: "spawn_failed" });
              throw new PsycheError("unavailable", `${host} could not start a shell`);
            }
            const t = now();
            const s: Session = {
              id,
              deviceId,
              pty,
              startedAt: t,
              lastActivity: t,
              pending: [],
              pendingChars: 0,
              sent: 0,
              acked: 0,
              paused: false,
              detached: false,
              exited: undefined,
              flushTimer: undefined,
              subscriptions: [],
              input: { tokens: limits.writeBurstBytes, at: t },
              calls: { tokens: limits.callBurst, at: t },
              resizes: { tokens: limits.resizeBurst, at: t },
              inputChars: 0,
              droppedChars: 0,
            };
            sessions.set(s.id, s);
            s.subscriptions.push(
              pty.onData((data) => onData(s, data)),
              pty.onExit(({ exitCode }) => onExit(s, exitCode)),
            );
            // The socket may have closed while this open waited on presence or the spawn; its
            // disconnect event has already passed, so start the grace clock now.
            if (!deviceOnline(deviceId)) detachDevice(deviceId);
            return { sessionId: s.id, target: "host" as const, label: target.label };
          } finally {
            pendingOpens -= 1;
          }
        },
      },
      "terminal.session.write": {
        run(call: Call, params: { sessionId: string; data: string }) {
          const s = owned(call, params.sessionId, "write");
          const bytes = Buffer.byteLength(params.data, "utf8");
          if (bytes > TERMINAL_WRITE_MAX_BYTES) {
            throw new PsycheError("invalid_params", "That write is too large");
          }
          if (!take(s.input, bytes, limits.writeBurstBytes, limits.writeBytesPerSecond, now())) {
            throw new PsycheError("rate_limited", "Typing too fast for this terminal; slow down", {
              retryable: true,
            });
          }
          s.inputChars += params.data.length;
          if (s.exited === undefined) s.pty.write(params.data);
          return {};
        },
      },
      "terminal.session.resize": {
        run(call: Call, params: { sessionId: string; cols: number; rows: number }) {
          const s = owned(call, params.sessionId, "resize");
          if (s.exited === undefined) {
            try {
              s.pty.resize(params.cols, params.rows);
            } catch {
              // exited between the check and the call
            }
          }
          return {};
        },
      },
      "terminal.session.ack": {
        run(call: Call, params: { sessionId: string; end: number }) {
          const s = owned(call, params.sessionId, "ack");
          // Only what was actually sent can be confirmed.
          s.acked = Math.max(s.acked, Math.min(params.end, s.sent));
          drain(s);
          return {};
        },
      },
      "terminal.session.close": {
        run(call: Call, params: { sessionId: string }) {
          const s = sessions.get(params.sessionId);
          if (s === undefined || s.deviceId !== call.identity.deviceId) return { closed: false };
          finish(s, "closed", null);
          return { closed: true };
        },
      },
    };

    return {
      handlers,
      start(gw) {
        gateway = gw;
        gw.context.deviceDisconnected.add(detachDevice);
        gw.context.terminalSessions.owns = (deviceId, sessionId) =>
          sessions.get(sessionId)?.deviceId === deviceId;
        sweep = setInterval(() => {
          const t = now();
          for (const s of [...sessions.values()]) {
            if (t - s.lastActivity > limits.idleTimeoutMs) finish(s, "idle", null);
          }
          // Output stops promptly when admin is taken away or the device was revoked, even
          // while its socket stays open (scopes are otherwise re-read on the next request).
          for (const deviceId of new Set([...sessions.values()].map((s) => s.deviceId))) {
            if (!stillAllowed(deviceId)) killDevice(deviceId, "device_revoked");
          }
        }, limits.sweepMs);
        sweep.unref?.();
      },
      stop() {
        gateway?.context.deviceDisconnected.delete(detachDevice);
        if (gateway) gateway.context.terminalSessions.owns = null;
        if (sweep !== undefined) clearInterval(sweep);
        sweep = undefined;
        for (const t of graceTimers.values()) clearTimeout(t);
        graceTimers.clear();
        for (const s of [...sessions.values()]) finish(s, "gateway_stopped", null);
        gateway = null;
      },
    };
  };
}

/**
 * The default presence rule. With a verifier ready (Touch ID through the Host's helper, a
 * passkey) the owner must approve a device-only card bound to this open; the retry carries its
 * `approvalId`. With none, or when the last one was lost, only the desktop shell on the Host
 * (loopback, the per-launch handshake secret) may open a terminal; any other device is told to
 * open it on the Host, because admin alone is not enough for a shell on the owner's Mac.
 */
export function defaultPresence(hostName: () => string): HostTerminalPresence {
  return {
    async check(call, input) {
      if (call.ctx.presenceState() === "ready") {
        await requireFreshPresence(
          call,
          {
            name: "method:terminal.session.open",
            summary: `Open a terminal on ${hostName()}`,
            // Bound to the folder only: the window size may change between the two calls.
            subject: { cwd: input.cwd ?? null },
            details: { method: "terminal.session.open", cwd: input.cwd ?? null },
          },
          input.approvalId,
        );
        return;
      }
      const onHost =
        call.identity.desktopShell === true &&
        call.conn.peer.remoteLoopback &&
        call.conn.peer.origin === null;
      if (!onHost) {
        throw new PsycheError("forbidden", `Open the terminal on ${hostName()}`, {
          details: { reason: "host_terminal_needs_presence" },
        });
      }
    },
  };
}
