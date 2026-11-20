import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayClient, type HttpProbe, probeGateway, type WebSocketFactory } from "./client.ts";
import { CliError } from "./errors.ts";
import { type Exec, nodeExec } from "./exec.ts";
import { loadOrCreateIdentity } from "./identity.ts";
import { isLoopbackHost, resolveGatewayUrl, resolveHome, wsUrl } from "./paths.ts";
import { type Prompter, ttyPrompter } from "./prompt.ts";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  stdin: NodeJS.ReadableStream;
}

/** Everything a command may touch; tests replace any of it. */
export interface Deps {
  env: NodeJS.ProcessEnv;
  io: Io;
  exec: Exec;
  fetch: typeof fetch;
  prompter: Prompter;
  platform: NodeJS.Platform;
  uid: number;
  now: () => Date;
  createWebSocket?: WebSocketFactory;
}

export interface GlobalOptions {
  json: boolean;
  url?: string;
  home?: string;
  insecure: boolean;
  timeoutMs: number;
}

/**
 * Reads a file under `run/` the way a secret deserves: not through a symlink (`O_NOFOLLOW`), owned
 * by this user and with no group/other access (checked on the open descriptor, so nothing can be
 * swapped between check and read). Anything else reads as absent. Windows has no such modes; its
 * `run/` is locked by ACL (`ensureHome`), so only the plain read applies there.
 */
function readPrivateFile(path: string): string | undefined {
  try {
    if (process.platform === "win32") return readFileSync(path, "utf8");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
        return undefined;
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * `$PSYCHE_HOME` and `run/` must be real directories of ours: not symlinks, owned by this user, the
 * home not writable by group or other, `run/` closed to them entirely.
 */
function runDirIsPrivate(home: string): boolean {
  if (process.platform === "win32") return true;
  try {
    const uid = process.getuid?.();
    const h = lstatSync(home);
    if (!h.isDirectory() || h.uid !== uid || (h.mode & 0o022) !== 0) return false;
    const r = lstatSync(join(home, "run"));
    return r.isDirectory() && r.uid === uid && (r.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * The address the local Gateway says it is bound to, when `listen.json` is present and private:
 * the CLI's default URL. It matters when the Gateway binds a name that resolves to one concrete
 * address (`gateway.host: localhost` lists `127.0.0.1` or `::1`), which the built-in default
 * `127.0.0.1` would miss.
 */
function listenedUrl(home: string): string | undefined {
  if (!runDirIsPrivate(home)) return undefined;
  try {
    const text = readPrivateFile(join(home, "run", "listen.json"));
    const first = (JSON.parse(text ?? "{}") as { origins?: unknown[] }).origins?.[0];
    return typeof first === "string" && first.startsWith("http://") ? first : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `url` is exactly an address this home's own `psyched` is bound to. The Gateway writes the
 * origin(s) it really listens on (the address it bound, not the configured name) to
 * `$PSYCHE_HOME/run/listen.json` before it writes the handshake secret; scheme, host and port must
 * all equal a listed origin. `localhost` never matches (it can resolve to an address another
 * account holds), `[::1]` is `::1`, and with no readable, private file nothing matches, so a
 * Gateway that is down or an old one gets no secret.
 */
export function isOwnGatewayUrl(
  url: URL,
  home: string,
  read: (path: string) => string | undefined = readPrivateFile,
): boolean {
  const key = (u: URL) => `${u.protocol}//${u.hostname.replace(/^\[|\]$/g, "")}:${u.port || "80"}`;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.toLowerCase() === "localhost" || !isLoopbackHost(host)) return false;
  if (!runDirIsPrivate(home)) return false;
  let listed: unknown;
  try {
    const text = read(join(home, "run", "listen.json"));
    if (text === undefined) return false;
    listed = (JSON.parse(text) as { origins?: unknown }).origins;
  } catch {
    return false;
  }
  if (!Array.isArray(listed)) return false;
  return listed.some((o) => {
    try {
      return typeof o === "string" && key(new URL(o)) === key(url);
    } catch {
      return false;
    }
  });
}

/**
 * The Host proof for `url`, or `undefined`. The secret is read FIRST and `listen.json` second (the
 * Gateway writes them in the other order), so a secret read here was written after the
 * `listen.json` compared against: a restart cannot pair a new secret with a stale origin.
 */
export function readHostSecret(
  url: URL,
  home: string,
  read: (path: string) => string | undefined = readPrivateFile,
): string | undefined {
  if (!runDirIsPrivate(home)) return undefined;
  const secret = read(join(home, "run", "handshake.secret"))?.trim();
  if (!secret) return undefined;
  return isOwnGatewayUrl(url, home, read) ? secret : undefined;
}

export class Ctx {
  readonly deps: Deps;
  readonly opts: GlobalOptions;
  readonly home: string;
  private client: GatewayClient | undefined;

  constructor(deps: Deps, opts: GlobalOptions) {
    this.deps = deps;
    this.opts = opts;
    this.home = resolveHome(deps.env, opts.home);
  }

  get json(): boolean {
    return this.opts.json;
  }

  get env(): NodeJS.ProcessEnv {
    return this.deps.env;
  }

  gatewayUrl(): URL {
    // No --url, PSYCHE_URL or PSYCHE_PORT: the address the local Gateway says it is bound to.
    const { env } = this.deps;
    const chosen =
      this.opts.url ?? (env.PSYCHE_URL || env.PSYCHE_PORT ? undefined : listenedUrl(this.home));
    return resolveGatewayUrl(env, chosen, { insecure: this.opts.insecure });
  }

  probe(): Promise<HttpProbe> {
    return probeGateway(this.gatewayUrl(), this.deps.fetch);
  }

  /** A paired connection, opened on first use and closed by the runner. */
  async gateway(): Promise<GatewayClient> {
    if (this.client) return this.client;
    const supported = ["darwin", "linux", "win32"];
    if (!supported.includes(this.deps.platform)) {
      throw new CliError("usage", `Unsupported platform ${this.deps.platform}`);
    }
    const identity = loadOrCreateIdentity(this.home, this.deps.now());
    // The Host proof (`isLocalHostCli` on the Gateway): the launch secret, read from this
    // computer's own `$PSYCHE_HOME/run`, and sent only to the exact address that Gateway says it is
    // bound to (`run/listen.json`). Any other URL, loopback or not, gets nothing.
    const handshakeSecret = readHostSecret(this.gatewayUrl(), this.home);
    this.client = await GatewayClient.connect({
      wsUrl: wsUrl(this.gatewayUrl()),
      ...(handshakeSecret ? { handshakeSecret } : {}),
      identity,
      // Declare the real OS so the Gateway gives a Windows CLI the desktop surface, like a Mac one.
      platform:
        this.deps.platform === "darwin"
          ? "macos"
          : this.deps.platform === "win32"
            ? "windows"
            : "linux",
      timeoutMs: this.opts.timeoutMs,
      ...(this.deps.createWebSocket ? { createWebSocket: this.deps.createWebSocket } : {}),
    });
    return this.client;
  }

  /** Like `gateway()` but returns null instead of throwing (doctor, audit, status). */
  async tryGateway(): Promise<{ client: GatewayClient | null; error?: unknown }> {
    try {
      return { client: await this.gateway() };
    } catch (error) {
      return { client: null, error };
    }
  }

  close(): void {
    this.client?.close();
    this.client = undefined;
  }
}

export function defaultDeps(): Deps {
  return {
    env: process.env,
    io: {
      out: (t) => process.stdout.write(t.endsWith("\n") ? t : `${t}\n`),
      err: (t) => process.stderr.write(t.endsWith("\n") ? t : `${t}\n`),
      stdin: process.stdin,
    },
    exec: nodeExec,
    fetch,
    prompter: ttyPrompter(),
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    now: () => new Date(),
  };
}
