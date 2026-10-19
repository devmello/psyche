import { GatewayClient, type HttpProbe, probeGateway, type WebSocketFactory } from "./client.ts";
import { CliError } from "./errors.ts";
import { type Exec, nodeExec } from "./exec.ts";
import { loadOrCreateIdentity } from "./identity.ts";
import { resolveGatewayUrl, resolveHome, wsUrl } from "./paths.ts";
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
    return resolveGatewayUrl(this.deps.env, this.opts.url, { insecure: this.opts.insecure });
  }

  probe(): Promise<HttpProbe> {
    return probeGateway(this.gatewayUrl(), this.deps.fetch);
  }

  /** A paired connection, opened on first use and closed by the runner. */
  async gateway(): Promise<GatewayClient> {
    if (this.client) return this.client;
    if (this.deps.platform !== "darwin" && this.deps.platform !== "linux") {
      throw new CliError("usage", `Unsupported platform ${this.deps.platform}`);
    }
    const identity = loadOrCreateIdentity(this.home, this.deps.now());
    this.client = await GatewayClient.connect({
      wsUrl: wsUrl(this.gatewayUrl()),
      identity,
      platform: this.deps.platform === "darwin" ? "macos" : "linux",
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
