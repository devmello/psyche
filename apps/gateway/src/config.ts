import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_GATEWAY_HOST, DEFAULT_GATEWAY_PORT, PsycheError } from "@psyche/protocol";

/** Resolved Gateway configuration (feature A5 is S01's; this is the bootstrap subset). */
export interface GatewayConfig {
  /** `$PSYCHE_HOME`, default `~/.psyche` (architecture §12). */
  home: string;
  host: string;
  /** 0 picks an ephemeral port (tests). */
  port: number;
  /** SQLite file, default `$PSYCHE_HOME/state/psyche.sqlite`; `:memory:` for tests. */
  dbPath: string;
  /** Unix socket for local nodes (mac helper), default `$PSYCHE_HOME/run/node.sock`. */
  nodeSocketPath: string;
  /** Built web UI served at `/` when present, default `apps/web/dist`. */
  webRoot: string | null;
  /** Extra allowed WebSocket `Origin` values (configured publicOrigin, app scheme). */
  allowedOrigins: string[];
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  const home = resolve(overrides.home ?? env.PSYCHE_HOME ?? join(homedir(), ".psyche"));
  const host = overrides.host ?? env.PSYCHE_HOST ?? DEFAULT_GATEWAY_HOST;
  const port = overrides.port ?? (env.PSYCHE_PORT ? Number(env.PSYCHE_PORT) : DEFAULT_GATEWAY_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new PsycheError(
      "invalid_params",
      `PSYCHE_PORT must be an integer 0-65535, got ${env.PSYCHE_PORT}`,
    );
  }
  // Security §10: a non-loopback bind needs an explicit bind setting *and* an auth mode.
  // Neither exists in the bootstrap Gateway, so refuse rather than expose an unauthenticated API.
  if (!isLoopbackHost(host)) {
    throw new PsycheError(
      "forbidden",
      `Refusing to bind ${host}: non-loopback binds require gateway.bind and an auth mode (not implemented yet, S01)`,
    );
  }
  const defaultWebRoot = resolve(import.meta.dirname, "../../web/dist");
  return {
    home,
    host,
    port,
    dbPath: overrides.dbPath ?? env.PSYCHE_DB ?? join(home, "state", "psyche.sqlite"),
    nodeSocketPath:
      overrides.nodeSocketPath ?? env.PSYCHE_NODE_SOCKET ?? join(home, "run", "node.sock"),
    webRoot:
      overrides.webRoot === undefined ? (env.PSYCHE_WEB_ROOT ?? defaultWebRoot) : overrides.webRoot,
    allowedOrigins:
      overrides.allowedOrigins ?? env.PSYCHE_ALLOWED_ORIGINS?.split(",").filter(Boolean) ?? [],
  };
}
