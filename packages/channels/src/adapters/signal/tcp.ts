import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { win32 } from "node:path";

/**
 * signal-cli on Windows (security §9). Node cannot reach an AF_UNIX socket there, so Psyche talks
 * to the owner's `signal-cli -a <number> daemon --tcp 127.0.0.1:7583` over loopback instead. A TCP
 * port has no owner or mode to check before connecting, so the check runs on the connection itself
 * before a byte is written: the process at the far end must belong to the current Windows user and
 * must not also listen beyond this computer. What cannot be established is refused.
 */

export interface SignalTcpAddress {
  host: string;
  port: number;
}

export interface SignalEndpoint {
  address: string;
  port: number;
}

/** `127.0.0.1:7583`, `localhost:7583` or `[::1]:7583`; anything that is not loopback is not one. */
export function parseSignalTcpAddress(value: string): SignalTcpAddress | undefined {
  const m = /^(?:\[(::1)\]|([0-9.]+)|(localhost)):(\d{1,5})$/i.exec(value.trim());
  if (m === null) return undefined;
  const port = Number(m[4]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  if (m[1] !== undefined) return { host: "::1", port };
  if (m[3] !== undefined) return { host: "localhost", port };
  const host = m[2] ?? "";
  return isIP(host) === 4 && isLoopbackAddress(host) ? { host, port } : undefined;
}

/** Normal form for comparing addresses: no brackets or zone, IPv4-mapped IPv6 as IPv4. */
function normalAddress(address: string): string {
  const a = address
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  return a.startsWith("::ffff:") && isIP(a.slice(7)) === 4 ? a.slice(7) : a;
}

/** 127.0.0.0/8 or ::1 (also as IPv4-mapped IPv6). */
export function isLoopbackAddress(address: string): boolean {
  const a = normalAddress(address);
  if (a === "::1") return true;
  return isIP(a) === 4 && a.startsWith("127.");
}

interface NetstatRow {
  local: SignalEndpoint;
  foreign: SignalEndpoint;
  pid: number;
}

function parseEndpoint(text: string): SignalEndpoint | undefined {
  const at = text.lastIndexOf(":");
  if (at <= 0) return undefined;
  const port = Number(text.slice(at + 1));
  if (!Number.isInteger(port)) return undefined;
  return { address: normalAddress(text.slice(0, at)), port };
}

/**
 * TCP rows of `netstat -ano`. The state column is localized, so it is not read: a listener is the
 * row whose foreign port is 0.
 */
export function parseNetstat(text: string): NetstatRow[] {
  const rows: NetstatRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+)\s+(\S+)\s+(?:.*\s)?(\d+)\s*$/i.exec(line);
    if (m === null) continue;
    const local = parseEndpoint(m[1] ?? "");
    const foreign = parseEndpoint(m[2] ?? "");
    if (local === undefined || foreign === undefined) continue;
    rows.push({ local, foreign, pid: Number(m[3]) });
  }
  return rows;
}

/** The user name (`DOMAIN\user`) in `tasklist /v /fo csv /nh` output for `pid`; undefined for N/A. */
export function tasklistUser(text: string, pid: number): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((f) =>
      (f[1] ?? "").replace(/""/g, '"'),
    );
    if (fields.length < 7 || fields[1] !== String(pid)) continue;
    const user = fields[6]?.trim() ?? "";
    return user === "" || user.toUpperCase() === "N/A" || !user.includes("\\") ? undefined : user;
  }
  return undefined;
}

function sameEndpoint(a: SignalEndpoint, b: SignalEndpoint): boolean {
  return a.port === b.port && normalAddress(a.address) === normalAddress(b.address);
}

export interface SignalPeerTools {
  /** `netstat -ano` output. */
  netstat(): Promise<string>;
  /** The account (`DOMAIN\user`) running `pid`; undefined when Windows will not say (not ours). */
  processUser(pid: number): Promise<string | undefined>;
}

const TOOL_TIMEOUT_MS = 10_000;

/** Windows tools by absolute path: Git for Windows puts its own look-alikes first on PATH. */
function system32(exe: string): string {
  return win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
}

function run(exe: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      system32(exe),
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    );
  });
}

export const windowsPeerTools: SignalPeerTools = {
  netstat: () => run("netstat.exe", ["-ano"]),
  processUser: async (pid) =>
    tasklistUser(
      await run("tasklist.exe", ["/v", "/fo", "csv", "/nh", "/fi", `PID eq ${pid}`]),
      pid,
    ),
};

let cachedUser: Promise<string | undefined> | undefined;

/** The current Windows account as `DOMAIN\user` (from `whoami`), or undefined. */
export function currentWindowsUser(): Promise<string | undefined> {
  cachedUser ??= run("whoami.exe", []).then(
    (out) => {
      const user = out.trim();
      return user.includes("\\") ? user : undefined;
    },
    () => undefined,
  );
  return cachedUser;
}

/**
 * Checks the process on the far end of an open loopback connection (`local` is our end, `remote`
 * the daemon's): it must run as `user` and listen on loopback only. Returns the problem, or
 * undefined when it is the owner's own daemon. `label` names the daemon in messages.
 */
export async function checkSignalTcpPeer(
  connection: { local: SignalEndpoint; remote: SignalEndpoint },
  user: string,
  label: string,
  tools: SignalPeerTools = windowsPeerTools,
): Promise<string | undefined> {
  const { local, remote } = connection;
  if (!isLoopbackAddress(remote.address)) {
    return `signal-cli at ${label} is not on this computer's loopback; run the daemon with --tcp 127.0.0.1:<port>`;
  }
  let rows: NetstatRow[];
  try {
    rows = parseNetstat(await tools.netstat());
  } catch {
    return `cannot tell which program is listening at ${label}`;
  }
  const server = rows.find((r) => sameEndpoint(r.local, remote) && sameEndpoint(r.foreign, local));
  if (server === undefined || server.pid <= 0) {
    return `cannot tell which program is listening at ${label}`;
  }
  const exposed = rows.find(
    (r) =>
      r.pid === server.pid &&
      r.foreign.port === 0 &&
      r.local.port === remote.port &&
      !isLoopbackAddress(r.local.address),
  );
  if (exposed !== undefined) {
    return `the signal-cli daemon at ${label} also listens beyond this computer (${exposed.local.address}); run it with --tcp 127.0.0.1:${remote.port}`;
  }
  let owner: string | undefined;
  try {
    owner = await tools.processUser(server.pid);
  } catch {
    owner = undefined;
  }
  if (owner === undefined || owner.toLowerCase() !== user.toLowerCase()) {
    return `the signal-cli daemon at ${label} belongs to another user${owner === undefined ? "" : ` (${owner})`}; run the daemon as this user`;
  }
  return undefined;
}
