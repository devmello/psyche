import type { McpToolName } from "@psyche/protocol";

/**
 * Tool keys users see in allow / ask / deny rules: `mcp__<server>__<tool>` (security §11).
 * Dots, spaces and other characters outside `[A-Za-z0-9_-]` become `_`, as in Claude Code, so a
 * rule written there transfers. A double underscore inside a server id would make the key
 * ambiguous, so server ids are restricted further.
 */
export const SERVER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]|_(?!_)){0,47}$/;

/** Spec SEP-986 / Anthropic directory policy: tool names are at most 64 characters. */
export const MAX_TOOL_NAME_LENGTH = 64;

export function isValidServerId(id: string): boolean {
  return SERVER_ID_PATTERN.test(id);
}

export function sanitizeToolName(tool: string): string {
  return tool.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function mcpToolName(serverId: string, tool: string): McpToolName {
  return `mcp__${serverId}__${sanitizeToolName(tool)}`;
}

/** Splits `mcp__<server>__<tool>`; the tool part is the sanitized name. */
export function parseMcpToolName(name: string): { serverId: string; tool: string } | undefined {
  const m = /^mcp__([a-z0-9](?:[a-z0-9-]|_(?!_))*)__(.+)$/.exec(name);
  if (m === null) return undefined;
  return { serverId: m[1] ?? "", tool: m[2] ?? "" };
}
