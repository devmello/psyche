import type { CatalogueEntry } from "./types.ts";

/**
 * Catalogue rows without a local adapter (M4 data): first-party remote MCP servers, connected
 * through `@psyche/mcp-host` with trust `verified` (known vendor host), and later-milestone
 * connectors shown as unavailable. Endpoints from research notes "MCP & connectors — 4".
 */
const mcpPreset = (
  id: string,
  label: string,
  vendor: string,
  description: string,
  url: string,
  docsUrl: string,
  readOnlyUrl?: string,
): CatalogueEntry => ({
  type: "mcp",
  id,
  label,
  description,
  category: "remote_mcp",
  vendor,
  auth: "oauth",
  scopes: { read: [], read_act: [] },
  // MCP tools get their rows from tools/list once connected (mcp__<id>__<tool>).
  actions: [],
  remote: { url, transport: "http", ...(readOnlyUrl === undefined ? {} : { readOnlyUrl }) },
  docsUrl,
  available: true,
});

export const REMOTE_MCP_PRESETS: CatalogueEntry[] = [
  mcpPreset(
    "slack",
    "Slack",
    "Slack",
    "Search and read messages, post and draft in channels you allow.",
    "https://mcp.slack.com/mcp",
    "https://docs.slack.dev/ai/mcp-server/",
  ),
  mcpPreset(
    "notion",
    "Notion",
    "Notion",
    "Search, read and edit pages in your Notion workspace.",
    "https://mcp.notion.com/mcp",
    "https://developers.notion.com/docs/get-started-with-mcp",
  ),
  mcpPreset(
    "linear",
    "Linear",
    "Linear",
    "Read and update issues and projects.",
    "https://mcp.linear.app/mcp",
    "https://linear.app/docs/mcp",
    "https://mcp.linear.app/mcp/readonly",
  ),
  mcpPreset(
    "github",
    "GitHub",
    "GitHub",
    "Repositories, issues and pull requests.",
    "https://api.githubcopilot.com/mcp/",
    "https://github.com/github/github-mcp-server",
  ),
];

/** Hosts whose first-party MCP servers may be added with trust `verified`. */
export const VERIFIED_MCP_HOSTS = new Set(
  REMOTE_MCP_PRESETS.flatMap((e) => (e.remote === undefined ? [] : [new URL(e.remote.url).host])),
);

const later = (
  id: string,
  type: string,
  label: string,
  vendor: string,
  description: string,
): CatalogueEntry => ({
  type,
  id,
  label,
  description,
  category: "first_party",
  vendor,
  auth: id === "imap" ? "app_password" : "oauth",
  scopes: { read: [], read_act: [] },
  actions: [],
  available: false,
});

export const COMING_SOON: CatalogueEntry[] = [
  later(
    "microsoft",
    "microsoft",
    "Microsoft 365",
    "Microsoft",
    "Outlook mail and calendar, OneDrive (M6).",
  ),
  later(
    "imap",
    "imap",
    "Other mail (IMAP)",
    "IMAP / SMTP",
    "Any mailbox with an app password (M7).",
  ),
  later("jmap", "jmap", "Fastmail", "Fastmail", "Mail through JMAP with an API token (M7)."),
];
