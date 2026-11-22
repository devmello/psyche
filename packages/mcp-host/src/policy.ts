import type { Tool } from "@modelcontextprotocol/client";
import type { McpTrustTier, ProvenanceOut, SideEffect } from "@psyche/protocol";
import { isMoneyText, isMoneyToolName, moneyWords } from "@psyche/protocol/money-intent";

/** A tool whose name starts with one of these only reads about money. */
const READING_VERBS = new Set([
  "get",
  "list",
  "read",
  "search",
  "find",
  "fetch",
  "show",
  "view",
  "describe",
  "check",
  "lookup",
  "count",
  "query",
  "preview",
  "estimate",
]);

/**
 * Whether an MCP tool looks like it moves money, by its own name and description (the shared rule
 * in `@psyche/protocol/money-intent`: a money verb with a money object or amount, so
 * `send_money`, `execute_trade`, "Places a stock market order" match and `git_checkout`,
 * `transfer_file`, `create_invoice` or "Sends an adaptive card" do not). Both are the server's
 * words (untrusted), so a match only ever raises a tool to `financial`; it is a guess that a
 * server can dodge by naming things differently. `McpServerConfig.handlesMoney` is the owner's
 * switch that does not depend on it, in both directions.
 */
export function looksFinancial(
  tool: Partial<Pick<Tool, "name" | "title" | "description">>,
): boolean {
  if (isMoneyToolName(tool.name)) return true;
  // A reading verb in the name still wins over a description that merely mentions money.
  const first = moneyWords(tool.name ?? "")[0];
  if (first !== undefined && READING_VERBS.has(first)) return false;
  return [tool.title, tool.description].some((x) => typeof x === "string" && isMoneyText(x));
}

/**
 * Side-effect class of an MCP tool (security §11: "annotations are untrusted hints, actionable
 * only for `bundled`"). For `bundled` servers the hints are taken at face value. For `verified`
 * and `unknown` servers a hint may only raise severity: `readOnlyHint` never lowers a tool below
 * `write`, while `destructiveHint` still raises it to `destructive`.
 *
 * `financial` (the one class that needs the owner's presence) comes from the owner's per-server
 * `handlesMoney` switch: `true` forces every tool of that server, `false` forces none (the guess
 * is off for it), unset leaves it to `looksFinancial` on the tool's name and description. A
 * bundled server's `readOnlyHint` still wins over the guess.
 */
export function sideEffectFor(
  tool: Pick<Tool, "annotations"> & Partial<Pick<Tool, "name" | "title" | "description">>,
  trust: McpTrustTier,
  opts: { handlesMoney?: boolean } = {},
): SideEffect {
  if (opts.handlesMoney === true) return "financial";
  const guess = opts.handlesMoney !== false;
  const a = tool.annotations ?? {};
  // Spec defaults: destructiveHint true when readOnlyHint is false/absent.
  const readOnly = a.readOnlyHint === true;
  const destructive = !readOnly && a.destructiveHint === true;
  if (trust === "bundled") {
    if (readOnly) return "read";
    if (guess && looksFinancial(tool)) return "financial";
    return destructive ? "destructive" : "write";
  }
  if (guess && looksFinancial(tool)) return "financial";
  return destructive ? "destructive" : "write";
}

/** Results from anything but a bundled server are data, never instructions (security §7.2). */
export function provenanceFor(trust: McpTrustTier): ProvenanceOut {
  return trust === "bundled" ? "trusted" : "untrusted";
}

/**
 * Tools whose server-declared `_meta` asks for a prompt on every call (Claude Code's
 * `anthropic/requiresUserInteraction`). The host reports it so the broker can refuse standing
 * grants; it is a hint that only ever makes policy stricter.
 */
export function requiresUserInteraction(tool: Pick<Tool, "_meta">): boolean {
  return (
    (tool._meta as Record<string, unknown> | undefined)?.["anthropic/requiresUserInteraction"] ===
    true
  );
}
