import type { McpTrustTier } from "./contracts/McpHost.ts";

/**
 * Which MCP servers the Gateway may stamp `verified` (security §11: "verified means registry
 * namespace proof, not safety"). The one list behind both the Gateway's trust tier and the
 * Official badge of the Add connector gallery (`packages/ui` presets are tested against it).
 *
 * Conservative on purpose: an exact package name or an exact vendor host (and path, where the
 * host is shared). Anything else, and any owner-edited command, is `unknown`.
 */

/** npm scope whose `server-*` packages are the MCP project's own reference servers. */
const MCP_SCOPE = "@modelcontextprotocol/";

/** Exact npm packages by vendors, run as `npx [-y] <package>[@version] …`. */
export const OFFICIAL_NPM_PACKAGES: readonly string[] = [
  "@brave/brave-search-mcp-server",
  "@playwright/mcp",
  "@stripe/mcp",
];

/** Exact PyPI packages of the MCP project's reference servers, run as `uvx <package> …`. */
export const OFFICIAL_PYPI_PACKAGES: readonly string[] = [
  "mcp-server-fetch",
  "mcp-server-git",
  "mcp-server-time",
];

/**
 * Vendors' own remote MCP endpoints. A host that serves other things too (`gitlab.com`) is
 * matched with its path as well.
 */
export const OFFICIAL_REMOTE_ENDPOINTS: readonly { host: string; path?: string }[] = [
  { host: "api.githubcopilot.com", path: "/mcp" },
  { host: "gitlab.com", path: "/api/v4/mcp" },
  { host: "mcp.sentry.dev" },
  { host: "mcp.linear.app" },
  { host: "mcp.atlassian.com" },
  { host: "mcp.notion.com" },
  { host: "ai.todoist.net", path: "/mcp" },
  { host: "mcp.firecrawl.dev" },
];

/** The package in `name@version` (a leading `@` is the scope, not a version). */
function packageName(spec: string): string {
  const at = spec.indexOf("@", 1);
  return at === -1 ? spec : spec.slice(0, at);
}

const VERSION = /^[A-Za-z0-9._~^-]+$/;

/** `name` or `name@version`; a version tag or semver, never a URL, path or git ref. */
function plainSpec(spec: string): string | undefined {
  const name = packageName(spec);
  const version = spec.slice(name.length + 1);
  if (spec.length > name.length && !VERSION.test(version)) return undefined;
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ? name : undefined;
}

/** Whether `name` is one of the MCP project's reference servers (`@modelcontextprotocol/server-*`). */
function isReferenceServer(name: string): boolean {
  return name.startsWith(`${MCP_SCOPE}server-`) && name.length > MCP_SCOPE.length + "server-".length;
}

/** The official package a stdio command runs, or undefined. Only `npx [-y]` / `uvx` launches. */
export function officialCommandPackage(command: readonly string[]): string | undefined {
  const [runner, ...rest] = command;
  if (runner === "npx") {
    const args = rest[0] === "-y" || rest[0] === "--yes" ? rest.slice(1) : rest;
    const name = args[0] === undefined ? undefined : plainSpec(args[0]);
    if (name === undefined) return undefined;
    return isReferenceServer(name) || OFFICIAL_NPM_PACKAGES.includes(name) ? name : undefined;
  }
  if (runner === "uvx") {
    const first = rest[0];
    // `--from`, `--with`, an index URL … would run a different package than the one named.
    if (first === undefined || first.startsWith("-")) return undefined;
    const at = first.indexOf("==");
    const name = at === -1 ? first : first.slice(0, at);
    return OFFICIAL_PYPI_PACKAGES.includes(name) ? name : undefined;
  }
  return undefined;
}

/** The official endpoint a remote URL is, or undefined. https, no credentials, default port. */
export function officialRemoteHost(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "") {
    return undefined;
  }
  const path = u.pathname.replace(/\/+$/, "");
  const hit = OFFICIAL_REMOTE_ENDPOINTS.find(
    (e) => e.host === u.hostname && (e.path === undefined || path === e.path),
  );
  return hit?.host;
}

/** The transport of a server as `mcp.servers` and `McpServerInput` both hold it. */
export type McpSourceTransport =
  | { kind: "stdio"; command: readonly string[] }
  | { kind: "http"; url: string };

/**
 * The tier an owner-added server earns from where it comes from: `verified` for an official
 * package or vendor endpoint, else `unknown`. Never `bundled` (only the host's own ids are).
 */
export function mcpTrustFor(transport: McpSourceTransport): Exclude<McpTrustTier, "bundled"> {
  const official =
    transport.kind === "stdio"
      ? officialCommandPackage(transport.command) !== undefined
      : officialRemoteHost(transport.url) !== undefined;
  return official ? "verified" : "unknown";
}
