import type { WidgetOp, WidgetSpec } from "./schemas/widgets.ts";
import { validateWidgetSpec, type WidgetIssue } from "./widgets-validate.ts";

/**
 * Applies patch ops to a spec (generative-ui-2026 §5.2). Pure: the Gateway uses it to apply and
 * persist, the UI uses it to follow `widget.updated` events, so both agree on the result. The
 * patched spec is validated whole, so a patch can never push a widget past a limit.
 */

type Node = Record<string, unknown>;
export type WidgetApplyResult =
  | { ok: true; spec: WidgetSpec }
  | { ok: false; issues: WidgetIssue[] };

const fail = (path: string, message: string): WidgetApplyResult => ({
  ok: false,
  issues: [{ path, message }],
});

const isNode = (v: unknown): v is Node => !!v && typeof v === "object" && !Array.isArray(v);

/** Every child list of a node, as [owner, key] pairs so ops can splice them in place. */
function childLists(n: Node): Array<{ list: unknown[]; holder: Node; key: string }> {
  const out: Array<{ list: unknown[]; holder: Node; key: string }> = [];
  if (Array.isArray(n.children)) out.push({ list: n.children, holder: n, key: "children" });
  if (Array.isArray(n.tabs)) {
    for (const t of n.tabs) {
      if (isNode(t) && Array.isArray(t.children))
        out.push({ list: t.children, holder: t, key: "children" });
    }
  }
  return out;
}

function find(
  n: Node,
  id: string,
): { node: Node; parent: { list: unknown[]; index: number } | null } | null {
  if (n.id === id) return { node: n, parent: null };
  for (const { list } of childLists(n)) {
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!isNode(c)) continue;
      if (c.id === id) return { node: c, parent: { list, index: i } };
      const deeper = find(c, id);
      if (deeper) return deeper;
    }
  }
  return null;
}

/** Nodes addressable inside list-like props (checklist items, list items, ...) by their own id. */
function findItem(n: Node, id: string): { list: unknown[]; index: number } | null {
  for (const key of ["items", "entries", "options", "fields"]) {
    const list = n[key];
    if (!Array.isArray(list)) continue;
    const index = list.findIndex((x) => isNode(x) && x.id === id);
    if (index !== -1) return { list, index };
  }
  return null;
}

function findItemDeep(n: Node, id: string): { list: unknown[]; index: number } | null {
  const here = findItem(n, id);
  if (here) return here;
  for (const { list } of childLists(n)) {
    for (const c of list) {
      if (isNode(c)) {
        const d = findItemDeep(c, id);
        if (d) return d;
      }
    }
  }
  return null;
}

export function applyWidgetOps(spec: WidgetSpec, ops: readonly WidgetOp[]): WidgetApplyResult {
  const next = structuredClone(spec) as WidgetSpec;
  const root = next.root as Node;
  for (const [i, op] of ops.entries()) {
    const at = `ops[${i}]`;
    if (op.op === "meta") {
      if (op.title !== undefined) next.title = op.title;
      if (op.fallbackText !== undefined) next.fallbackText = op.fallbackText;
      continue;
    }
    const hit = find(root, op.id);
    if (op.op === "set") {
      const target = hit?.node;
      if (!target) {
        // A checklist/list item addressed by its own id merges into that item.
        const item = findItemDeep(root, op.id);
        const obj = item?.list[item.index];
        if (!item || !isNode(obj)) return fail(at, `No node or item with id '${op.id}'.`);
        Object.assign(obj, op.props, { id: op.id });
        continue;
      }
      if ("type" in op.props || "id" in op.props) {
        return fail(at, "set cannot change `id` or `type`; use replace.");
      }
      Object.assign(target, op.props);
    } else if (op.op === "append" || op.op === "prepend") {
      if (!hit) return fail(at, `No node with id '${op.id}'.`);
      const list = hit.node[op.field];
      if (!Array.isArray(list))
        return fail(`${at}.field`, `'${op.field}' is not a list on node '${op.id}'.`);
      if (op.op === "append") list.push(...structuredClone(op.items));
      else list.unshift(...structuredClone(op.items));
    } else if (op.op === "remove") {
      if (hit?.parent) hit.parent.list.splice(hit.parent.index, 1);
      else if (hit) return fail(at, "The root node cannot be removed.");
      else {
        const item = findItemDeep(root, op.id);
        if (!item) return fail(at, `No node or item with id '${op.id}'.`);
        item.list.splice(item.index, 1);
      }
    } else if (op.op === "replace") {
      if (!hit) return fail(at, `No node with id '${op.id}'.`);
      if (!hit.parent) next.root = structuredClone(op.node);
      else hit.parent.list[hit.parent.index] = structuredClone(op.node);
    }
  }
  const v = validateWidgetSpec(next);
  return v.ok ? { ok: true, spec: next } : { ok: false, issues: v.issues };
}
