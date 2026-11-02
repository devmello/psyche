import { PsycheError, type WidgetSpec } from "@psyche/protocol";

/**
 * Resolves the tool call a widget control proposes (generative-ui-2026 §6.2). The call and its
 * arguments come from the widget's STORED spec; a request names only the control (node, and item
 * for a list row) and the values the owner typed into a form. So a page, a channel message or
 * another widget cannot forge a call, and the arguments are exactly what the owner can read in the
 * transcript message this produces.
 */

type N = Record<string, unknown>;
const isNode = (v: unknown): v is N => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Tools a button must never reach: the ones that obtain or raise permissions, install code or leave
 * plan mode. Approvals, grants and the like are host-owned (§7.4); the broker still decides every
 * other call.
 */
export const WIDGET_TOOL_DENY: ReadonlySet<string> = new Set([
  "request_permission",
  "exit_plan_mode",
  "install_capability",
  "run_script",
  "save_script_as_tool",
]);

function findNode(n: unknown, id: string, depth = 0): N | undefined {
  if (!isNode(n) || depth > 12) return undefined;
  if (n.id === id) return n;
  const lists: unknown[][] = [];
  if (Array.isArray(n.children)) lists.push(n.children);
  if (Array.isArray(n.tabs)) {
    for (const t of n.tabs) if (isNode(t) && Array.isArray(t.children)) lists.push(t.children);
  }
  for (const list of lists) {
    for (const c of list) {
      const hit = findNode(c, id, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

export interface ResolvedToolAction {
  tool: string;
  args: Record<string, unknown>;
  /** What the owner reads in the transcript: the tool and every argument, nothing hidden. */
  text: string;
}

function bad(message: string): never {
  throw new PsycheError("invalid_params", message);
}

export function resolveToolAction(
  spec: WidgetSpec,
  nodeId: string,
  itemId: string | undefined,
  values: Record<string, string | number | boolean> | undefined,
  options: { preview?: boolean } = {},
): ResolvedToolAction {
  const node = findNode(spec.root, nodeId);
  if (node === undefined) throw new PsycheError("not_found", "That control is not in this widget.");
  let tool: string | undefined;
  let args: Record<string, unknown> = {};
  if (node.type === "button" && isNode(node.action) && node.action.kind === "tool") {
    tool = String(node.action.tool);
    args = isNode(node.action.args) ? structuredClone(node.action.args) : {};
  } else if (node.type === "list" && itemId !== undefined) {
    const item = (Array.isArray(node.items) ? node.items : []).find(
      (i) => isNode(i) && i.id === itemId,
    );
    if (isNode(item) && isNode(item.action) && item.action.kind === "tool") {
      tool = String(item.action.tool);
      args = isNode(item.action.args) ? structuredClone(item.action.args) : {};
    }
  } else if (node.type === "form" && isNode(node.submit) && node.submit.as === "tool") {
    tool = typeof node.submit.tool === "string" ? node.submit.tool : undefined;
    const fields = (Array.isArray(node.fields) ? node.fields : []).filter(isNode);
    // A dry run only needs the tool; the owner's values are checked when they submit.
    const given = options.preview === true ? {} : (values ?? {});
    for (const key of Object.keys(given)) {
      if (!fields.some((f) => f.id === key)) bad(`The form has no field '${key}'.`);
    }
    for (const f of fields) {
      const id = String(f.id);
      const v = given[id];
      if (v === undefined || v === "") {
        if (f.required === true && f.type !== "toggle" && options.preview !== true)
          bad(`'${String(f.label)}' is required.`);
        continue;
      }
      if (f.type === "number") {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) bad(`'${String(f.label)}' must be a number.`);
        args[id] = n;
      } else if (f.type === "toggle") {
        args[id] = v === true || v === "true";
      } else if (f.type === "select") {
        const ok = (Array.isArray(f.options) ? f.options : []).some((o) => isNode(o) && o.id === v);
        if (!ok) bad(`'${String(f.label)}' is not one of the offered options.`);
        args[id] = v;
      } else {
        if (typeof v !== "string") bad(`'${String(f.label)}' must be text.`);
        args[id] = v;
      }
    }
  }
  if (tool === undefined) throw new PsycheError("not_found", "That control proposes no tool call.");
  if (WIDGET_TOOL_DENY.has(tool)) {
    throw new PsycheError("forbidden", `A widget cannot propose ${tool}: it is host-owned.`);
  }
  const shown = JSON.stringify(args);
  const text = `Run ${tool}${shown === "{}" ? "" : ` with ${shown.length > 600 ? `${shown.slice(0, 600)}…` : shown}`}`;
  return { tool, args, text };
}
