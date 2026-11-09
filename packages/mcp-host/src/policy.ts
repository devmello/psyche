import type { Tool } from "@modelcontextprotocol/client";
import type { McpTrustTier, ProvenanceOut, SideEffect } from "@psyche/protocol";

/**
 * Money-moving words in a tool's name, matched per name segment (split on `_ - . /` and camelCase)
 * so `reorder_list` or `border_radius` do not match `order`. A tool whose name starts with a
 * reading verb (`get_`, `list_`, `search_`…) only reads about them and is not matched.
 */
const MONEY_SEGMENTS = new Set([
  "pay",
  "payment",
  "payments",
  "charge",
  "charges",
  "transfer",
  "transfers",
  "refund",
  "refunds",
  "invoice",
  "invoices",
  "payout",
  "payouts",
  "purchase",
  "purchases",
  "checkout",
  "order",
  "orders",
  "subscribe",
  "subscription",
  "withdraw",
  "wire",
  "donate",
  "buy",
]);
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

/** Name segments: `createPaymentIntent` → create, payment, intent; `place-order` → place, order. */
function segmentsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((x) => x !== "");
}

/**
 * A description that says the tool moves money: a money-moving verb and a money word close
 * together ("Charges the customer's credit card", "Transfers funds between accounts").
 */
const MONEY_DESCRIPTION =
  /\b(pay|pays|paying|charge|charges|charging|transfer|transfers|transferring|send|sends|sending|wire|wires|refund|refunds|refunding|withdraw|withdraws|purchase|purchases|buy|buys|order|orders|donate|donates)\b[^.\n]{0,60}\b(money|funds|payments?|usd|eur|gbp|dollars?|euros?|credit cards?|debit cards?|bank accounts?|cards?|invoices?)\b/i;

/**
 * Whether an MCP tool looks like it moves money, by its own name and description. Both are the
 * server's words (untrusted), so a match only ever raises a tool to `financial`; it is a guess
 * that a server can dodge by naming things differently. `McpServerConfig.handlesMoney` is the
 * owner's switch that does not depend on it.
 */
export function looksFinancial(
  tool: Partial<Pick<Tool, "name" | "title" | "description">>,
): boolean {
  const segs = segmentsOf(tool.name ?? "");
  const first = segs[0];
  const reading = first !== undefined && READING_VERBS.has(first);
  if (!reading && segs.some((x) => MONEY_SEGMENTS.has(x))) return true;
  const text = [tool.title, tool.description].filter((x) => typeof x === "string").join(". ");
  // A reading verb in the name still wins over a description that merely mentions money.
  return !reading && MONEY_DESCRIPTION.test(text);
}

/**
 * Side-effect class of an MCP tool (security §11: "annotations are untrusted hints, actionable
 * only for `bundled`"). For `bundled` servers the hints are taken at face value. For `verified`
 * and `unknown` servers a hint may only raise severity: `readOnlyHint` never lowers a tool below
 * `write`, while `destructiveHint` still raises it to `destructive`.
 *
 * `financial` (the one class that needs the owner's presence) comes from the owner's per-server
 * `handlesMoney` switch, which forces every tool of that server, or from `looksFinancial` on the
 * tool's name and description. A bundled server's `readOnlyHint` still wins over the guess.
 */
export function sideEffectFor(
  tool: Pick<Tool, "annotations"> & Partial<Pick<Tool, "name" | "title" | "description">>,
  trust: McpTrustTier,
  opts: { handlesMoney?: boolean } = {},
): SideEffect {
  if (opts.handlesMoney === true) return "financial";
  const a = tool.annotations ?? {};
  // Spec defaults: destructiveHint true when readOnlyHint is false/absent.
  const readOnly = a.readOnlyHint === true;
  const destructive = !readOnly && a.destructiveHint === true;
  if (trust === "bundled") {
    if (readOnly) return "read";
    if (looksFinancial(tool)) return "financial";
    return destructive ? "destructive" : "write";
  }
  if (looksFinancial(tool)) return "financial";
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
