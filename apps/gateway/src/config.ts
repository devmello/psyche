import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { assetPath, assetsRoot } from "@psyche/assets";
import { DEFAULT_GATEWAY_HOST, DEFAULT_GATEWAY_PORT, PsycheError } from "@psyche/protocol";
import type { RateLimitSettings } from "./compose/rate-limits.ts";
import { trustedProxyList } from "./proxy.ts";
import { resolveGuestSocketPath, resolveNodeSocketPath } from "./socket-path.ts";
import { type BindMode, containerAddress, readGatewayToken } from "./transport-gate.ts";
import { packagedAsar } from "./web-asar.ts";

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
  /**
   * Unix socket where the Host helper relays sandbox guests, default next to the node socket
   * (`guest.sock`); `null` when it does not fit a socket path (VM guests cannot connect).
   */
  guestSocketPath: string | null;
  /** Built web UI served at `/` when present, default `apps/web/dist`. */
  webRoot: string | null;
  /**
   * Psyche.app's `app.asar`, whose renderer build carries the web client (`web-asar.ts`); used
   * when `webRoot` has no build, which is how the app ships. `null` outside the app.
   */
  webAsar: string | null;
  /**
   * The public HTTPS origin the web client is served from behind a proxy (`gateway.publicOrigin`
   * or `PSYCHE_PUBLIC_ORIGIN`). Passkeys use its host as the WebAuthn RP ID; `null` = none.
   */
  publicOrigin: string | null;
  /** Extra allowed WebSocket `Origin` values (configured publicOrigin, app scheme). */
  allowedOrigins: string[];
  /**
   * Trusted-proxy mode (Tailscale Serve, Cloudflare Access). Only unlocks passkey login for the
   * web client later (INT-2); proxy identity headers never authorize anything by themselves.
   */
  trustedProxy: {
    enabled: boolean;
    trustedProxies: string[];
    tailscaleProxies?: string[];
    /** Tailscale logins allowed to open a forwarded connection; empty means no narrowing. */
    allowedLogins?: string[];
  };
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
  /**
   * `gateway.rateLimits` (security §10): inbound chat per sender and `web_fetch` per Task, per
   * minute. Absent keys use the defaults (30 and 60).
   */
  rateLimits?: Partial<RateLimitSettings>;
  /**
   * `credentials.onePassword` (feature G10): where the vault reads linked 1Password items. The
   * service-account or Connect token is never here: it is the vault's connector-owned
   * `onepassword` item. `null` = not configured (`vault.linkExternal` answers unavailable).
   */
  onePassword?: OnePasswordConfig | null;
  /**
   * `credentials.bitwarden` (feature G11): the Bitwarden CLI the vault reads linked items through.
   * The session key (`bw unlock --raw`) is never here: it is the vault's connector-owned
   * `bitwarden` item. `null` = not configured (`vault.linkExternal` answers unavailable).
   */
  bitwarden?: BitwardenConfig | null;
}

/**
 * The `bw` CLI (`bw`: an absolute path, default the first `bw` on PATH) and, optionally, its
 * data directory (`appDataDir`, the CLI's `BITWARDENCLI_APPDATA_DIR`).
 */
export interface BitwardenConfig {
  bw?: string;
  appDataDir?: string;
}

/**
 * The `op` CLI (`op`: an absolute path, default the first `op` on PATH) or a Connect server
 * (`url`: `https://…`, or loopback `http://127.0.0.1:8080`).
 */
export type OnePasswordConfig = { kind: "cli"; op?: string } | { kind: "connect"; url: string };

/**
 * `connectors.google` (#505): the owner's Google Cloud OAuth client, docs/guides/connectors-google.md.
 * The client id is not a secret; the client secret may only be a `{{cred:slug}}` vault placeholder.
 */
export interface GoogleClientConfig {
  clientId?: string;
  clientSecret?: string;
}

/** The keys `config.json` may set (no secrets; architecture §12). */
interface ConfigFile {
  gateway?: {
    host?: string;
    port?: number;
    allowedOrigins?: string[];
    publicOrigin?: string;
    trustedProxy?: {
      enabled?: boolean;
      trustedProxies?: string[];
      tailscaleProxies?: string[];
      allowedLogins?: string[];
    };
    cloudflareAccess?: { teamDomain: string; audience: string };
    rateLimits?: Partial<RateLimitSettings>;
  };
  credentials?: { onePassword?: OnePasswordConfig; bitwarden?: BitwardenConfig };
  connectors?: { google?: GoogleClientConfig };
}

/** A `{{cred:slug}}` placeholder, the vault's slug grammar. */
export const CRED_PLACEHOLDER = /^\{\{cred:[a-z0-9][a-z0-9-]{0,63}(\.[a-z]+)?\}\}$/;

const TOP_LEVEL_KEYS = new Set(["configVersion", "gateway", "credentials", "connectors"]);

/** `connectors` in `config.json`: client ids and vault placeholders, never a secret. */
function connectorsFrom(value: unknown, warn: ConfigWarn): NonNullable<ConfigFile["connectors"]> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    bad("connectors", "must be an object");
  const c = value as Record<string, unknown>;
  for (const key of Object.keys(c))
    if (key !== "google") unknownKey("connectors", key, ["google"], warn);
  if (c.google === undefined) return {};
  return { google: googleClientFrom(c.google, "connectors.google", warn) };
}

/** Validates a Google OAuth client from `config.json` or the environment. */
export function googleClientFrom(
  value: unknown,
  path: string,
  warn: ConfigWarn = warnUnknownKey,
): GoogleClientConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    bad(path, "must be an object");
  const g = value as Record<string, unknown>;
  for (const key of Object.keys(g))
    if (key !== "clientId" && key !== "clientSecret")
      unknownKey(path, key, ["clientId", "clientSecret"], warn);
  const out: GoogleClientConfig = {};
  if (g.clientId !== undefined) {
    if (
      typeof g.clientId !== "string" ||
      !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(g.clientId)
    )
      bad(`${path}.clientId`, "must be a Google OAuth client id (….apps.googleusercontent.com)");
    out.clientId = g.clientId;
  }
  if (g.clientSecret !== undefined) {
    if (typeof g.clientSecret !== "string" || !CRED_PLACEHOLDER.test(g.clientSecret))
      bad(
        `${path}.clientSecret`,
        "must be a {{cred:slug}} vault placeholder, never the secret itself",
      );
    out.clientSecret = g.clientSecret;
  }
  return out;
}

/** `credentials` in `config.json`: references to external sources only, never a secret. */
function credentialsFrom(value: unknown, warn: ConfigWarn): NonNullable<ConfigFile["credentials"]> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    bad("credentials", "must be an object");
  const c = value as Record<string, unknown>;
  for (const key of Object.keys(c))
    if (key !== "onePassword" && key !== "bitwarden")
      unknownKey("credentials", key, ["onePassword", "bitwarden"], warn);
  const bw = c.bitwarden === undefined ? {} : { bitwarden: bitwardenFrom(c.bitwarden, warn) };
  if (c.onePassword === undefined) return bw;
  return { ...bw, ...onePasswordFrom(c.onePassword, warn) };
}

/** `credentials.bitwarden`: paths only; the session key lives in the vault. */
function bitwardenFrom(value: unknown, warn: ConfigWarn): BitwardenConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    bad("credentials.bitwarden", "must be an object");
  const b = value as Record<string, unknown>;
  // A secret in this file is refused outright, not warned about and left on disk.
  if (b.session !== undefined)
    bad("credentials.bitwarden.session", "is not allowed: the session key lives in the vault");
  for (const key of Object.keys(b))
    if (key !== "bw" && key !== "appDataDir")
      unknownKey("credentials.bitwarden", key, ["bw", "appDataDir"], warn);
  const out: BitwardenConfig = {};
  for (const key of ["bw", "appDataDir"] as const) {
    const v = b[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !isAbsolute(v))
      bad(`credentials.bitwarden.${key}`, "must be an absolute path");
    out[key] = v;
  }
  return out;
}

/** `credentials.onePassword`: the `op` CLI or a Connect URL; the token lives in the vault. */
function onePasswordFrom(
  value: unknown,
  warn: ConfigWarn,
): Pick<NonNullable<ConfigFile["credentials"]>, "onePassword"> {
  const op = value as Record<string, unknown>;
  if (op === null || typeof op !== "object" || Array.isArray(op))
    bad("credentials.onePassword", "must be an object");
  if (op.token !== undefined)
    bad("credentials.onePassword.token", "is not allowed: the token lives in the vault");
  for (const key of Object.keys(op))
    if (!["kind", "op", "url"].includes(key))
      unknownKey("credentials.onePassword", key, ["kind", "op", "url"], warn);
  if (op.kind === "cli") {
    if (op.op !== undefined && (typeof op.op !== "string" || !isAbsolute(op.op)))
      bad("credentials.onePassword.op", "must be an absolute path to the op binary");
    return {
      onePassword: { kind: "cli", ...(op.op === undefined ? {} : { op: op.op as string }) },
    };
  }
  if (op.kind === "connect") {
    let url: URL;
    try {
      url = new URL(String(op.url));
    } catch {
      return bad("credentials.onePassword.url", "must be the Connect server's URL");
    }
    const loopback =
      url.protocol === "http:" && isLoopbackHost(url.hostname.replace(/^\[|\]$/g, ""));
    if (url.protocol !== "https:" && !loopback)
      bad("credentials.onePassword.url", "must be https:// (or a loopback http:// address)");
    return { onePassword: { kind: "connect", url: url.origin } };
  }
  return bad("credentials.onePassword.kind", 'must be "cli" or "connect"');
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

/**
 * A key this build does not know. Never fatal (updates design §2.7): a newer version may have
 * written it, and a rollback must still start. It is left in the file untouched (nothing here
 * writes `config.json` back) and mentioned once per process.
 */
export type ConfigWarn = (path: string) => void;

/** The `configVersion` this build writes and understands. A file may declare a newer one. */
export const CONFIG_VERSION = 1;

/** Levenshtein distance, for catching a typo of a key that matters. */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] as number;
      prev[j] = Math.min(
        up + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1]?.toLowerCase() === b[j - 1]?.toLowerCase() ? 0 : 1),
      );
      diag = up;
    }
  }
  return prev[b.length] as number;
}

/** The closest of `known` within two edits of `key`, if any. */
function nearKey(key: string, known: readonly string[]): string | undefined {
  return known.find((k) => editDistance(key, k) <= 2 && key.length > 2);
}

/**
 * Whether unknown keys may be tolerated: only when the file declares a `configVersion` newer
 * than this build understands (a newer version wrote it, and a rollback must still start).
 * Otherwise a key that is unknown in a security section, or one edit or two away from a known
 * key, is a typo: refusing it is what keeps a misspelt `allowedLogins` from meaning "any login".
 */
let tolerateNewer = false;

/**
 * An unknown key at `prefix`: fatal when it sits in a security section (`strict`) or looks like
 * a typo of one of `known`; otherwise a warning.
 */
function unknownKey(
  prefix: string,
  key: string,
  known: readonly string[],
  warn: ConfigWarn,
  strict = false,
): void {
  const path = prefix === "" ? key : `${prefix}.${key}`;
  if (!tolerateNewer) {
    const near = nearKey(key, known);
    if (near !== undefined)
      bad(
        path,
        `is not a known key (did you mean "${near}"? a misspelt setting is refused, not ignored)`,
      );
    if (strict) bad(path, `is not a known key (known: ${known.join(", ")})`);
  }
  warn(path);
}

const warned = new Set<string>();
/** Every unknown key warned about in this process, for `gateway.info` and the UI. */
export function configWarnings(): string[] {
  return [...warned];
}
const warnUnknownKey: ConfigWarn = (path) => {
  if (warned.has(path)) return;
  warned.add(path);
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "config.json has a key this version does not know; ignoring it and leaving it in the file", key: path })}\n`,
  );
};

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
export function readConfigFile(path: string, warn: ConfigWarn = warnUnknownKey): ConfigFile {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    bad("", `is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) bad("", "must be an object");
  const credentialsRaw = (raw as { credentials?: unknown }).credentials;
  const declared = (raw as { configVersion?: unknown }).configVersion;
  if (declared !== undefined && (!Number.isInteger(declared) || (declared as number) < 1))
    bad("configVersion", "must be a positive integer");
  tolerateNewer = typeof declared === "number" && declared > CONFIG_VERSION;
  for (const key of Object.keys(raw as object))
    if (!TOP_LEVEL_KEYS.has(key)) unknownKey("", key, [...TOP_LEVEL_KEYS], warn);
  const credentials =
    credentialsRaw === undefined ? undefined : credentialsFrom(credentialsRaw, warn);
  const connectorsRaw = (raw as { connectors?: unknown }).connectors;
  const connectors = connectorsRaw === undefined ? undefined : connectorsFrom(connectorsRaw, warn);
  const withCredentials = (file: ConfigFile): ConfigFile => ({
    ...file,
    ...(credentials === undefined ? {} : { credentials }),
    ...(connectors === undefined ? {} : { connectors }),
  });
  const gateway = (raw as { gateway?: unknown }).gateway;
  if (gateway === undefined) return withCredentials({});
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
    "rateLimits",
  ]);
  for (const key of Object.keys(g))
    if (!known.has(key)) unknownKey("gateway", key, [...known], warn);
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
    if (tp === null || typeof tp !== "object" || Array.isArray(tp))
      bad("gateway.trustedProxy", "must be an object");
    // Strict: a misspelt `allowedLogins` must never read as "no list", which means any login.
    const tpKeys = ["enabled", "trustedProxies", "tailscaleProxies", "allowedLogins"];
    for (const key of Object.keys(tp))
      if (!tpKeys.includes(key)) unknownKey("gateway.trustedProxy", key, tpKeys, warn, true);
    if (tp.enabled !== undefined && typeof tp.enabled !== "boolean")
      bad("gateway.trustedProxy.enabled", "must be a boolean");
    const proxies = stringArray(tp.trustedProxies, "gateway.trustedProxy.trustedProxies");
    const tailscale = stringArray(tp.tailscaleProxies, "gateway.trustedProxy.tailscaleProxies");
    const logins = stringArray(tp.allowedLogins, "gateway.trustedProxy.allowedLogins");
    out.trustedProxy = {
      ...(tp.enabled === undefined ? {} : { enabled: tp.enabled as boolean }),
      ...(logins ? { allowedLogins: logins } : {}),
      ...(proxies ? { trustedProxies: proxies } : {}),
      ...(tailscale ? { tailscaleProxies: tailscale } : {}),
    };
  }
  if (g.cloudflareAccess !== undefined) {
    const cf = g.cloudflareAccess as Record<string, unknown>;
    if (cf === null || typeof cf !== "object" || Array.isArray(cf))
      bad("gateway.cloudflareAccess", "must be an object");
    const cfKeys = ["teamDomain", "audience"];
    for (const key of Object.keys(cf))
      if (!cfKeys.includes(key)) unknownKey("gateway.cloudflareAccess", key, cfKeys, warn, true);
    if (typeof cf.teamDomain !== "string" || cf.teamDomain === "") {
      bad("gateway.cloudflareAccess.teamDomain", "must be a host name");
    }
    if (typeof cf.audience !== "string" || cf.audience === "") {
      bad("gateway.cloudflareAccess.audience", "must be the Access application's AUD tag");
    }
    out.cloudflareAccess = { teamDomain: cf.teamDomain as string, audience: cf.audience as string };
  }
  if (g.rateLimits !== undefined) out.rateLimits = rateLimitsFrom(g.rateLimits, warn);
  return withCredentials({ gateway: out });
}

function rateLimitsFrom(value: unknown, warn: ConfigWarn): Partial<RateLimitSettings> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    bad("gateway.rateLimits", "must be an object");
  const out: Partial<RateLimitSettings> = {};
  for (const [key, n] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "inboundChatPerMinute" && key !== "fetchPerMinute") {
      unknownKey("gateway.rateLimits", key, ["inboundChatPerMinute", "fetchPerMinute"], warn);
      continue;
    }
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 10_000)
      bad(`gateway.rateLimits.${key}`, "must be an integer 1-10000");
    out[key] = n as number;
  }
  return out;
}

/** An HTTPS origin (or `http://localhost[:port]` for development), without path. */
function normalizePublicOrigin(value: string | null): string | null {
  if (value === null || value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PsycheError("invalid_params", `gateway.publicOrigin is not a URL: ${value}`);
  }
  const local = url.protocol === "http:" && url.hostname === "localhost";
  if (url.protocol !== "https:" && !local) {
    throw new PsycheError(
      "invalid_params",
      "gateway.publicOrigin must be https:// (passkeys need a secure origin)",
    );
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new PsycheError(
      "invalid_params",
      "gateway.publicOrigin must be an origin without a path",
    );
  }
  return url.origin;
}

export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  const home = resolve(overrides.home ?? env.PSYCHE_HOME ?? join(homedir(), ".psyche"));
  const configFile = readConfigFile(join(home, "config.json"));
  const file = configFile.gateway ?? {};
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
  const allowedLogins = file.trustedProxy?.allowedLogins ?? [];
  if (allowedLogins.length > 0 && !trustedProxyEnabled) {
    throw new PsycheError(
      "invalid_params",
      "config.json: gateway.trustedProxy.allowedLogins needs trustedProxy.enabled",
    );
  }
  trustedProxyList(trustedProxies); // malformed CIDRs fail at startup
  trustedProxyList(tailscaleProxies);
  const publicOrigin = normalizePublicOrigin(
    overrides.publicOrigin !== undefined
      ? overrides.publicOrigin
      : (env.PSYCHE_PUBLIC_ORIGIN ?? file.publicOrigin ?? null),
  );
  const defaultWebRoot = assetPath("apps/web/dist");
  const nodeSocketPath = resolveNodeSocketPath(
    home,
    overrides.nodeSocketPath ?? env.PSYCHE_NODE_SOCKET,
  );
  return {
    home,
    host,
    port,
    dbPath: overrides.dbPath ?? env.PSYCHE_DB ?? join(home, "state", "psyche.sqlite"),
    nodeSocketPath,
    guestSocketPath:
      overrides.guestSocketPath !== undefined
        ? overrides.guestSocketPath
        : resolveGuestSocketPath(nodeSocketPath, env.PSYCHE_GUEST_SOCKET, process.platform, home),
    webRoot:
      overrides.webRoot === undefined ? (env.PSYCHE_WEB_ROOT ?? defaultWebRoot) : overrides.webRoot,
    webAsar:
      overrides.webAsar !== undefined
        ? overrides.webAsar
        : overrides.webRoot === undefined && env.PSYCHE_WEB_ROOT === undefined
          ? packagedAsar(assetsRoot(env))
          : null,
    publicOrigin,
    allowedOrigins: overrides.allowedOrigins ??
      env.PSYCHE_ALLOWED_ORIGINS?.split(",").filter(Boolean) ?? [
        ...(file.allowedOrigins ?? []),
        ...(publicOrigin ? [publicOrigin] : []),
      ],
    trustedProxy: overrides.trustedProxy ?? {
      enabled: trustedProxyEnabled,
      trustedProxies,
      tailscaleProxies,
      allowedLogins,
    },
    bind,
    gatewayToken,
    cloudflareAccess:
      overrides.cloudflareAccess !== undefined
        ? overrides.cloudflareAccess
        : (file.cloudflareAccess ?? null),
    ...((overrides.rateLimits ?? file.rateLimits) === undefined
      ? {}
      : { rateLimits: (overrides.rateLimits ?? file.rateLimits) as Partial<RateLimitSettings> }),
    onePassword:
      overrides.onePassword !== undefined
        ? overrides.onePassword
        : (configFile.credentials?.onePassword ?? null),
    bitwarden:
      overrides.bitwarden !== undefined
        ? overrides.bitwarden
        : (configFile.credentials?.bitwarden ?? null),
  };
}
