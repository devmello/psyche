import {
  connectorToolName,
  FORK_FETCH_TOOL,
  FORK_REPORT_TOOL,
  FORK_SEARCH_TOOL,
  STAGEABLE_TOOLS,
  STAGING_CONNECTOR_TYPES,
} from "@psyche/agent-core";
import type { SideEffect } from "@psyche/protocol";

/**
 * The branch toolset (docs/design/fork-a-plan-2026.md §3.2). An allowlist built per branch, which
 * is stronger than refusing calls: browser, computer use (and paired machines), exec, MCP servers,
 * file writes, notes, `ask_user`, `exit_plan_mode`, `task.start`, `subagent.spawn`,
 * `specialist.spawn`, `schedule`, `notify`, Memory writes and every money tool are simply not
 * registered for the run. The loop's staging gate refuses them again, so a tool added here by
 * mistake still cannot run.
 *
 * Exact names only. A near-miss (`web_fetch` the connector, `memory`, `mail_send`) is not a
 * member, whatever its side-effect class says.
 */

/** Built-in reads (no connector prefix). */
export const FORK_BUILTIN_READS: ReadonlySet<string> = new Set([
  "memory_recall",
  "entity_recall",
  FORK_SEARCH_TOOL,
  FORK_FETCH_TOOL,
]);

/**
 * The tools that load other tools on demand. They can only load what the run's toolset allows, so
 * they widen nothing; without them a deferred tool of the list below could not be reached.
 */
export const FORK_LOADING_TOOLS: ReadonlySet<string> = new Set(["tool_search", "load_tools"]);

/** Connector reads by bare name (`mcp__<id>__<name>`), for a live connector of a stageable type. */
export const FORK_CONNECTOR_READS: ReadonlySet<string> = new Set([
  // Calendar
  "calendar_list_calendars",
  "calendar_list_events",
  "calendar_free_busy",
  "calendar_find_free_time",
  // Mail (tainted)
  "mail_search",
  "mail_search_messages",
  "mail_read",
  "mail_read_message",
  "gmail_search_threads",
  "gmail_read_thread",
  // Contacts and Messages, where connected (owner-only sources for remote viewers, §4.4)
  "contacts_search",
  "contacts_read",
  "messages_search",
  "messages_read",
]);

export interface ForkToolInput {
  /** The registered tool name. */
  tool: string;
  sideEffect: SideEffect;
  /** The live connector's type for an `mcp__<id>__` tool, else undefined. */
  connectorType?: string | undefined;
}

const isRead = (s: SideEffect): boolean => s === "read" || s === "none";

/** Whether a tool is registered for a branch's main task. */
export function forkToolVisible(input: ForkToolInput): boolean {
  if (input.tool === FORK_REPORT_TOOL) return input.sideEffect === "none";
  if (FORK_LOADING_TOOLS.has(input.tool)) return input.sideEffect === "none";
  const named = connectorToolName(input.tool);
  if (named === undefined) {
    return FORK_BUILTIN_READS.has(input.tool) && isRead(input.sideEffect);
  }
  if (input.connectorType === undefined || !STAGING_CONNECTOR_TYPES.has(input.connectorType)) {
    return false;
  }
  // The Night shift stageable writes: staged, never run (§3.1). Only as `write`.
  if (STAGEABLE_TOOLS.has(named.tool)) return input.sideEffect === "write";
  return FORK_CONNECTOR_READS.has(named.tool) && isRead(input.sideEffect);
}

/**
 * The forced-report task's toolset: nothing but the report. The loop cannot pin a tool choice, so
 * the reserve's last call is made safe by registering one tool.
 */
export function forcedReportToolVisible(
  input: Pick<ForkToolInput, "tool" | "sideEffect">,
): boolean {
  return input.tool === FORK_REPORT_TOOL && input.sideEffect === "none";
}
