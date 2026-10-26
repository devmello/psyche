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

export interface McpDraft {
  name: string;
  kind: McpKind;
  command: string;
  url: string;
  domains: string;
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
  return {
    id: serverId(name),
    name,
    transport: { kind: "stdio", command: splitCommand(d.command) },
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
