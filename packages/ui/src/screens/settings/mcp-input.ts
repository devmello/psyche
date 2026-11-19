import type { McpServerInput } from "@psyche/protocol";

/** What the Add MCP server form collects, and how it becomes an `mcp.probe` request (#529). */

/** `npx -y @scope/server --flag "two words"` → argv; no shell, quotes group words. */
export function splitCommand(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out.filter((x) => x !== "");
}

/** A stable id from the name: `My Files!` → `my-files`. */
export function serverId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(slug) && slug.length >= 2 ? slug : `mcp-${slug || "server"}`.slice(0, 40);
}

export type McpKind = "command" | "url";

/** An env variable the owner types into the form. `saved` once a secret value went to the vault. */
export interface EnvRow {
  key: string;
  name: string;
  value: string;
  saved?: boolean;
}

export interface McpDraft {
  name: string;
  kind: McpKind;
  command: string;
  url: string;
  domains: string;
  env?: readonly EnvRow[];
}

/** An env variable name the Gateway accepts (the `mcp.probe` schema). */
export const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** A variable whose name says it holds a secret: its value goes to the vault, never plain config. */
export const SECRET_ENV_NAME =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PAT|COOKIE|SESSION)/i;
export const isSecretEnvName = (name: string): boolean => SECRET_ENV_NAME.test(name);

/** False when a filled row has a name the Gateway would refuse. Empty rows are ignored. */
export function envNamesValid(rows: readonly EnvRow[] | undefined): boolean {
  return (rows ?? []).every((r) => r.name.trim() === "" || ENV_NAME.test(r.name.trim()));
}

/** The plain (non-secret) env the rows give. Secret-looking names are left to the vault path. */
export function plainEnv(rows: readonly EnvRow[] | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const r of rows ?? []) {
    const name = r.name.trim();
    if (!ENV_NAME.test(name) || isSecretEnvName(name) || r.value === "") continue;
    env[name] = r.value;
  }
  return env;
}

export function toServerInput(d: McpDraft): McpServerInput {
  const name = d.name.trim();
  if (d.kind === "url") {
    return { id: serverId(name), name, transport: { kind: "http", url: d.url.trim() } };
  }
  const domains = d.domains
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter((x) => x !== "");
  const env = plainEnv(d.env);
  return {
    id: serverId(name),
    name,
    transport: {
      kind: "stdio",
      command: splitCommand(d.command),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
    ...(domains.length > 0 ? { allowedDomains: domains } : {}),
  };
}

export const EMPTY_DRAFT: McpDraft = {
  name: "",
  kind: "command",
  command: "",
  url: "",
  domains: "",
};
