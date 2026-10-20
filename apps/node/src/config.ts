import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_GATEWAY_HOST, DEFAULT_GATEWAY_PORT, PsycheError } from "@psyche/protocol";
import type { FsRoot } from "./capabilities/fs.ts";
import type { VsockEndpoint } from "./transports/vsock.ts";

/**
 * psyche-node configuration: `<home>/node.json`, then environment, then flags (later wins).
 * Everything that widens what the node can do (fs roots, host exec) lives only in the file the
 * machine's owner edits; no flag or env var turns on host exec.
 */
export interface NodeConfig {
  home: string;
  name: string;
  gateway: {
    url?: string;
    socket?: string;
    vsock?: VsockEndpoint;
  };
  fs: { roots: FsRoot[] };
  exec: {
    sandbox: boolean;
    host: { enabled: boolean; cwdRoots: string[] };
  };
  browser: { enabled: "auto" | boolean };
  helper: { enabled: "auto" | boolean; socket?: string };
}

export type Command = "run" | "manifest" | "identity" | "version" | "help";

export interface ParsedArgs {
  command: Command;
  config: NodeConfig;
}

interface FileConfig {
  name?: string;
  gateway?: { url?: string; socket?: string; vsock?: Partial<VsockEndpoint> };
  fs?: { roots?: FsRoot[] };
  exec?: { sandbox?: boolean; host?: { enabled?: boolean; cwdRoots?: string[] } };
  browser?: { enabled?: "auto" | boolean };
  helper?: { enabled?: "auto" | boolean; socket?: string };
}

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PSYCHE_NODE_HOME) return resolve(env.PSYCHE_NODE_HOME);
  const psycheHome = env.PSYCHE_HOME ? resolve(env.PSYCHE_HOME) : join(homedir(), ".psyche");
  return join(psycheHome, "node");
}

/** Default WebSocket endpoint: the Gateway's loopback bind (security §10). */
export const DEFAULT_GATEWAY_URL = `ws://${DEFAULT_GATEWAY_HOST}:${DEFAULT_GATEWAY_PORT}/ws`;

export function parseVsock(spec: string): VsockEndpoint {
  const m = /^(\d+):(\d+)$/.exec(spec.trim());
  if (!m) throw new PsycheError("invalid_params", `vsock must be CID:PORT (got ${spec})`);
  return { cid: Number(m[1]), port: Number(m[2]) };
}

function parseBridge(spec: string): string[] {
  const trimmed = spec.trim();
  if (trimmed.startsWith("[")) {
    const argv = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string") || argv.length === 0) {
      throw new PsycheError("invalid_params", "PSYCHE_NODE_VSOCK_BRIDGE must be a JSON argv");
    }
    return argv as string[];
  }
  return trimmed.split(/\s+/);
}

function readFileConfig(path: string): FileConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch (err) {
    throw new PsycheError("invalid_params", `${path}: ${(err as Error).message}`);
  }
}

function validateRoots(roots: FsRoot[]): FsRoot[] {
  return roots.map((r) => {
    if (!r || typeof r.path !== "string" || !isAbsolute(r.path)) {
      throw new PsycheError("invalid_params", "fs.roots[].path must be an absolute path");
    }
    if (r.mode !== "ro" && r.mode !== "rw") {
      throw new PsycheError("invalid_params", `fs root ${r.path}: mode must be "ro" or "rw"`);
    }
    return { path: resolve(r.path), mode: r.mode };
  });
}

const USAGE = `psyche-node [run|manifest|identity|version] [options]

  --home DIR        node state directory (default $PSYCHE_NODE_HOME or $PSYCHE_HOME/node)
  --gateway URL     Gateway WebSocket, e.g. ws://127.0.0.1:7979/ws (or an SSH tunnel)
  --socket PATH     Gateway node socket on this machine ($PSYCHE_HOME/run/node.sock)
  --vsock CID:PORT  host Gateway over vsock (VM guests; preferred when running as a guest)
  --name NAME       name shown on the owner's pairing card

Capabilities (fs roots, host exec) are configured in <home>/node.json.`;

export function usage(): string {
  return USAGE;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  const flags = new Map<string, string>();
  let command: Command = "run";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--help" || arg === "-h") command = "help";
    else if (arg === "--version" || arg === "-v") command = "version";
    else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
      const value = inline ?? argv[++i];
      if (value === undefined) throw new PsycheError("invalid_params", `--${key} needs a value`);
      if (!["home", "gateway", "socket", "vsock", "name"].includes(key)) {
        throw new PsycheError("invalid_params", `unknown option --${key}`);
      }
      flags.set(key, value);
    } else if (["run", "manifest", "identity", "version", "help"].includes(arg)) {
      command = arg as Command;
    } else throw new PsycheError("invalid_params", `unknown argument ${arg}`);
  }

  const home = flags.has("home") ? resolve(flags.get("home") as string) : defaultHome(env);
  const file = readFileConfig(join(home, "node.json"));

  const gateway: NodeConfig["gateway"] = {};
  const url = flags.get("gateway") ?? env.PSYCHE_NODE_GATEWAY ?? file.gateway?.url;
  if (url) gateway.url = url;
  const socket = flags.get("socket") ?? env.PSYCHE_NODE_GATEWAY_SOCKET ?? file.gateway?.socket;
  if (socket) gateway.socket = resolve(socket);
  const vsockSpec = flags.get("vsock") ?? env.PSYCHE_NODE_VSOCK;
  if (vsockSpec) gateway.vsock = parseVsock(vsockSpec);
  else if (file.gateway?.vsock?.port !== undefined) {
    gateway.vsock = { cid: file.gateway.vsock.cid ?? 2, port: file.gateway.vsock.port };
    if (file.gateway.vsock.bridge) gateway.vsock.bridge = file.gateway.vsock.bridge;
  }
  if (gateway.vsock && env.PSYCHE_NODE_VSOCK_BRIDGE) {
    gateway.vsock.bridge = parseBridge(env.PSYCHE_NODE_VSOCK_BRIDGE);
  }

  const config: NodeConfig = {
    home,
    name: flags.get("name") ?? env.PSYCHE_NODE_NAME ?? file.name ?? `psyche-node on ${hostname()}`,
    gateway,
    fs: { roots: validateRoots(file.fs?.roots ?? []) },
    exec: {
      sandbox: file.exec?.sandbox ?? true,
      host: {
        enabled: file.exec?.host?.enabled === true,
        cwdRoots: (file.exec?.host?.cwdRoots ?? []).map((p) => resolve(p)),
      },
    },
    browser: { enabled: file.browser?.enabled ?? "auto" },
    helper: {
      enabled: file.helper?.enabled ?? "auto",
      ...(file.helper?.socket ? { socket: resolve(file.helper.socket) } : {}),
    },
  };
  return { command, config };
}
