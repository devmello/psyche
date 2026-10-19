import type { Tool } from "@modelcontextprotocol/client";
import type { Sha256 } from "@psyche/protocol";
import { sha256, strictCanonicalJSON } from "./canonical.ts";

/**
 * `tools/list` hash (security §11, "rug pull" defense). Every field the model reads or the
 * policy acts on is covered: name, title, description, input / output schema, annotations,
 * icons, execution hints and `_meta` (MCP Apps `ui.resourceUri`, `anthropic/*` hints). Tools are
 * sorted by name so a reordering alone (legacy servers need not list deterministically) does
 * not revoke grants.
 */
const HASHED_FIELDS = [
  "name",
  "title",
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
  "icons",
  "execution",
  "_meta",
] as const;

type HashedTool = Partial<Record<(typeof HASHED_FIELDS)[number], unknown>>;

function pick(tool: Tool): HashedTool {
  const out: HashedTool = {};
  const src = tool as unknown as Record<string, unknown>;
  for (const f of HASHED_FIELDS) if (src[f] !== undefined) out[f] = src[f];
  return out;
}

export function toolsListHash(tools: readonly Tool[]): Sha256 {
  const sorted = [...tools].map(pick).sort((a, b) => cmp(String(a.name), String(b.name)));
  return sha256(`psyche.mcp.tools.v1|${strictCanonicalJSON(sorted)}`);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface ToolChange {
  tool: string;
  change: "added" | "removed" | "changed";
  /** Fields that differ (for `changed`). */
  fields?: string[];
}

/** Per-tool diff between two listings, for the re-approval card's visual diff. */
export function diffTools(before: readonly Tool[], after: readonly Tool[]): ToolChange[] {
  const old = new Map(before.map((t) => [t.name, pick(t)]));
  const now = new Map(after.map((t) => [t.name, pick(t)]));
  const changes: ToolChange[] = [];
  for (const [name, t] of now) {
    const prev = old.get(name);
    if (prev === undefined) {
      changes.push({ tool: name, change: "added" });
      continue;
    }
    const fields = HASHED_FIELDS.filter(
      (f) => strictCanonicalJSON(prev[f] ?? null) !== strictCanonicalJSON(t[f] ?? null),
    );
    if (fields.length > 0) changes.push({ tool: name, change: "changed", fields: [...fields] });
  }
  for (const name of old.keys()) {
    if (!now.has(name)) changes.push({ tool: name, change: "removed" });
  }
  return changes.sort((a, b) => cmp(a.tool, b.tool));
}
