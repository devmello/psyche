import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_GATEWAY_HOST, DEFAULT_GATEWAY_PORT, PsycheError } from "@psyche/protocol";
import { trustedProxyList } from "./proxy.ts";

<<<<<<< HEAD

import { resolveNodeSocketPath } from "./socket-path.ts";

=======

import { type BindMode, containerAddress, readGatewayToken } from "./transport-gate.ts";

>>>>>>> origin/main

/** Resolved Gateway configuration (feature A5 subset; see README "Config keys"). */
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
  /**
   * Trusted-proxy mode (Tailscale Serve, Cloudflare Access). Only unlocks passkey login for the
   * web client later (INT-2); proxy identity headers never authorize anything by themselves.
   */
  trustedProxy: { enabled: boolean; trustedProxies: string[]; tailscaleProxies?: string[] };
  /**
   * `loopback` (default) or `container` (`PSYCHE_BIND=container`, security §10 "Docker
   * defaults"): listen on the container interface; see `src/transport-gate.ts`.
   */
  bind: BindMode;
  /** The transport token from `PSYCHE_GATEWAY_TOKEN_FILE` (container bind only). Never logged. */
  gatewayToken: string | null;
  /**
   * Cloudflare Access (`cloudflared`) in front: forwarded upgrades must carry a valid
   * `Cf-Access-Jwt-Assertion` for this team and application. `null` = not configured.
   */
  cloudflareAccess: { teamDomain: string; audience: string } | null;
}

/** The keys `config.json` may set (no secrets; architecture §12). */
interface ConfigFile {
  gateway?: {
    host?: string;
    port?: number;
    allowedOrigins?: string[];
    publicOrigin?: string;
    trustedProxy?: { enabled?: boolean; trustedProxies?: string[]; tailscaleProxies?: string[] };
    cloudflareAccess?: { teamDomain: string; audience: string };
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

function bad(path: string, message: string): never {
  throw new PsycheError("invalid_params", `config.json: ${path} ${message}`);
}

function stringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    bad(path, "must be an array of strings");
  return value as string[];
}

/** Reads and validates `$PSYCHE_HOME/config.json`; invalid config fails fast (feature A5). */
export function readConfigFile(path: string): ConfigFile {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    bad("", `is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) bad("", "must be an object");
  const gateway = (raw as { gateway?: unknown }).gateway;
  if (gateway === undefined) return {};
  if (gateway === null || typeof gateway !== "object" || Array.isArray(gateway))
    bad("gateway", "must be an object");
  const g = gateway as Record<string, unknown>;
  const known = new Set([
    "host",
    "port",
    "allowedOrigins",
    "publicOrigin",
    "trustedProxy",
    "cloudflareAccess",
  ]);
  for (const key of Object.keys(g))
    if (!known.has(key)) bad(`gateway.${key}`, "is not a known key");
  if (g.host !== undefined && typeof g.host !== "string") bad("gateway.host", "must be a string");
  if (
    g.port !== undefined &&
    (!Number.isInteger(g.port) || (g.port as number) < 0 || (g.port as number) > 65535)
  ) {
    bad("gateway.port", "must be an integer 0-65535");
  }
  if (g.publicOrigin !== undefined && typeof g.publicOrigin !== "string")
    bad("gateway.publicOrigin", "must be a string");
  const out: NonNullable<ConfigFile["gateway"]> = {};
  if (g.host !== undefined) out.host = g.host as string;
  if (g.port !== undefined) out.port = g.port as number;
  const origins = stringArray(g.allowedOrigins, "gateway.allowedOrigins");
  if (origins) out.allowedOrigins = origins;
  if (g.publicOrigin !== undefined) out.publicOrigin = g.publicOrigin as string;
  if (g.trustedProxy !== undefined) {
    const tp = g.trustedProxy as Record<string, unknown>;
    if (tp === null || typeof tp !== "object") bad("gateway.trustedProxy", "must be an object");
    if (tp.enabled !== undefined && typeof tp.enabled !== "boolean")
      bad("gateway.trustedProxy.enabled", "must be a boolean");
    const proxies = stringArray(tp.trustedProxies, "gateway.trustedProxy.trustedProxies");
    const tailscale = stringArray(tp.tailscaleProxies, "gateway.trustedProxy.tailscaleProxies");
    out.trustedProxy = {
      ...(tp.enabled === undefined ? {} : { enabled: tp.enabled as boolean }),
      ...(proxies ? { trustedProxies: proxies } : {}),
      ...(tailscale ? { tailscaleProxies: tailscale } : {}),
    };
  }
  if (g.cloudflareAccess !== undefined) {
    const cf = g.cloudflareAccess as Record<string, unknown>;
    if (cf === null || typeof cf !== "object") bad("gateway.cloudflareAccess", "must be an object");
    if (typeof cf.teamDomain !== "string" || cf.teamDomain === "") {
      bad("gateway.cloudflareAccess.teamDomain", "must be a host name");
    }
    if (typeof cf.audience !== "string" || cf.audience === "") {
      bad("gateway.cloudflareAccess.audience", "must be the Access application's AUD tag");
    }
    out.cloudflareAccess = { teamDomain: cf.teamDomain as string, audience: cf.audience as string };
  }
  return { gateway: out };
}

export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  const home = resolve(overrides.home ?? env.PSYCHE_HOME ?? join(homedir(), ".psyche"));
  const file = readConfigFile(join(home, "config.json")).gateway ?? {};
  const bindRaw = overrides.bind ?? env.PSYCHE_BIND ?? "loopback";
  if (bindRaw !== "loopback" && bindRaw !== "container") {
    throw new PsycheError(
      "invalid_params",
      `PSYCHE_BIND must be loopback or container, got ${bindRaw}`,
    );
  }
  const bind: BindMode = bindRaw;
  const host =
    overrides.host ??
    env.PSYCHE_HOST ??
    file.host ??
    (bind === "container" ? containerAddress() : DEFAULT_GATEWAY_HOST);
  const port =
    overrides.port ??
    (env.PSYCHE_PORT ? Number(env.PSYCHE_PORT) : (file.port ?? DEFAULT_GATEWAY_PORT));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new PsycheError(
      "invalid_params",
      `PSYCHE_PORT must be an integer 0-65535, got ${env.PSYCHE_PORT}`,
    );
  }
  // Security §10: a non-loopback bind needs the explicit container bind and its token. Wildcard
  // addresses are never accepted: the container interface only.
  if (bind === "loopback" && !isLoopbackHost(host)) {
    throw new PsycheError(
      "forbidden",
      `Refusing to bind ${host}: non-loopback binds require PSYCHE_BIND=container and PSYCHE_GATEWAY_TOKEN_FILE`,
    );
  }
  if (bind === "container" && (host === "0.0.0.0" || host === "::" || isLoopbackHost(host))) {
    throw new PsycheError(
      "forbidden",
      `Refusing to bind ${host}: PSYCHE_BIND=container binds the container interface`,
    );
  }
  const gatewayToken =
    bind === "container"
      ? (overrides.gatewayToken ?? readGatewayToken(env.PSYCHE_GATEWAY_TOKEN_FILE))
      : null;
  const trustedProxies = file.trustedProxy?.trustedProxies ?? [];
  const trustedProxyEnabled = file.trustedProxy?.enabled ?? false;
  if (trustedProxyEnabled && trustedProxies.length === 0) {
    throw new PsycheError(
      "invalid_params",
      "config.json: gateway.trustedProxy needs trustedProxies CIDRs",
    );
  }
  const tailscaleProxies = file.trustedProxy?.tailscaleProxies ?? [];
  trustedProxyList(trustedProxies); // malformed CIDRs fail at startup
  trustedProxyList(tailscaleProxies);
  const defaultWebRoot = resolve(import.meta.dirname, "../../web/dist");
  return {
    home,
    host,
    port,
    dbPath: overrides.dbPath ?? env.PSYCHE_DB ?? join(home, "state", "psyche.sqlite"),
    nodeSocketPath: resolveNodeSocketPath(home, overrides.nodeSocketPath ?? env.PSYCHE_NODE_SOCKET),
    webRoot:
      overrides.webRoot === undefined ? (env.PSYCHE_WEB_ROOT ?? defaultWebRoot) : overrides.webRoot,
    allowedOrigins: overrides.allowedOrigins ??
      env.PSYCHE_ALLOWED_ORIGINS?.split(",").filter(Boolean) ?? [
        ...(file.allowedOrigins ?? []),
        ...(file.publicOrigin ? [file.publicOrigin] : []),
      ],
    trustedProxy: overrides.trustedProxy ?? {
      enabled: trustedProxyEnabled,
      trustedProxies,
      tailscaleProxies,
    },
    bind,
    gatewayToken,
    cloudflareAccess:
      overrides.cloudflareAccess !== undefined
        ? overrides.cloudflareAccess
        : (file.cloudflareAccess ?? null),
  };
}
