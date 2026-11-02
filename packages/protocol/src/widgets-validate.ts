import { Value } from "@sinclair/typebox/value";
import {
  WIDGET_LIMITS,
  WIDGET_NODE_SCHEMAS,
  WIDGET_NODE_TYPES,
  WIDGET_SPEC_VERSION,
  WidgetNodeId,
  type WidgetNodeType,
  WidgetPatch,
  WidgetSpec,
} from "./schemas/widgets.ts";
import { bindingProblem } from "./widgets-bindings.ts";

/**
 * Gateway-side widget spec validation (generative-ui-2026 §4.3, §7.1, §7.4, §10.1). Pure, no I/O.
 * Errors name the node path and say how to fix it: they are returned to the model as the
 * `render_ui` / `update_ui` tool error so it can retry in the same turn.
 */

export interface WidgetIssue {
  /** e.g. `root.children[2].items[0].label` */
  path: string;
  message: string;
}

export type WidgetValidation = { ok: true } | { ok: false; issues: WidgetIssue[] };

const MAX_ISSUES = 20;

/** Words that make a control look like an approval (§7.4 layer 4). Compared after normalising. */
const RESERVED_LABEL_PREFIXES = [
  "allow",
  "always allow",
  "approve",
  "deny",
  "grant",
  "authorize",
  "authorise",
  "confirm payment",
  "permit",
];

/** Lookalike letters (Cyrillic/Greek) folded to Latin, plus zero-width and spacing characters. */
const CONFUSABLES: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ӏ: "l",
  ɑ: "a",
  ο: "o",
  ν: "v",
  ρ: "p",
  ι: "i",
  α: "a",
  ε: "e",
  τ: "t",
  κ: "k",
  ս: "u",
  ո: "n",
  "0": "o",
  "1": "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "@": "a",
  $: "s",
};

/** Normalises a label for the reserved-word check. Exported for the red-team tests. */
export function foldLabel(label: string): string {
  let out = "";
  for (const ch of label.normalize("NFKD").toLowerCase()) {
    if (/\p{M}|\p{Cf}|\p{Cc}/u.test(ch)) continue; // combining marks, zero-width, control
    out += CONFUSABLES[ch] ?? ch;
  }
  return out
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isReservedLabel(label: string): boolean {
  const folded = foldLabel(label);
  const squashed = folded.replace(/\s/g, "");
  return RESERVED_LABEL_PREFIXES.some(
    (w) => folded === w || folded.startsWith(`${w} `) || squashed.startsWith(w.replace(/\s/g, "")),
  );
}

const RESERVED_MESSAGE =
  "Labels that read like an approval (Allow, Approve, Deny, Grant, Authorize, Confirm payment) are reserved: approvals are host-owned cards the widget cannot draw or answer. Use a neutral verb such as 'Continue' or 'Send reply'.";

interface Ctx {
  issues: WidgetIssue[];
  ids: Set<string>;
  count: number;
}

function add(ctx: Ctx, path: string, message: string): void {
  if (ctx.issues.length < MAX_ISSUES) ctx.issues.push({ path, message });
}

function checkStrings(ctx: Ctx, value: unknown, path: string, type: string, key = ""): void {
  if (typeof value === "string") {
    const cap =
      key === "md" || key === "code"
        ? WIDGET_LIMITS.markdown
        : key === "dataUrl"
          ? Number.POSITIVE_INFINITY
          : key === "text" && path.endsWith(".action")
            ? 2000
            : WIDGET_LIMITS.string;
    if (value.length > cap && key !== "url" && key !== "template" && key !== "tool") {
      add(
        ctx,
        path,
        `String is ${value.length} chars; the limit for ${type}.${key || "value"} is ${cap}. Shorten it or split it.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      checkStrings(ctx, v, `${path}[${i}]`, type, key);
    });
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "children") continue; // walked as nodes
      checkStrings(ctx, v, `${path}.${k}`, type, k);
    }
  }
}

function reservedCheck(ctx: Ctx, type: string, n: Record<string, unknown>, path: string): void {
  const labels: Array<[string, unknown]> = [];
  if (type === "button") labels.push([`${path}.label`, n.label]);
  if (type === "form")
    labels.push([`${path}.submit.label`, (n.submit as { label?: unknown } | undefined)?.label]);
  if (type === "choices") {
    ((n.options as Array<{ label?: unknown }>) ?? []).forEach((o, i) => {
      labels.push([`${path}.options[${i}].label`, o?.label]);
    });
  }
  if (type === "list") {
    ((n.items as Array<{ title?: unknown; action?: unknown }>) ?? []).forEach((it, i) => {
      if (it?.action) labels.push([`${path}.items[${i}].title`, it.title]);
    });
  }
  for (const [p, l] of labels) {
    if (typeof l === "string" && isReservedLabel(l)) add(ctx, p, RESERVED_MESSAGE);
  }
}

function extraChecks(
  ctx: Ctx,
  type: WidgetNodeType,
  n: Record<string, unknown>,
  path: string,
): void {
  if (type === "progress") {
    const hasValue = typeof n.value === "number";
    if (!hasValue && n.indeterminate !== true && !n.bind) {
      add(ctx, path, "progress needs `value` (and `max`), or `indeterminate: true`, or a `bind`.");
    }
    if (hasValue && typeof n.max === "number" && (n.value as number) > n.max) {
      add(ctx, `${path}.value`, "value is greater than max.");
    }
  }
  if (type === "table") {
    const keys = new Set(((n.columns as Array<{ key: string }>) ?? []).map((c) => c.key));
    ((n.rows as Array<Record<string, unknown>>) ?? []).slice(0, 25).forEach((row, i) => {
      for (const k of Object.keys(row)) {
        if (!keys.has(k))
          add(ctx, `${path}.rows[${i}].${k}`, `Row key '${k}' is not a declared column key.`);
      }
    });
  }
  if (type === "form") {
    for (const [i, f] of (
      (n.fields as Array<{ type: string; options?: unknown[] }>) ?? []
    ).entries()) {
      if (f.type === "select" && !f.options?.length) {
        add(ctx, `${path}.fields[${i}].options`, "A select field needs options.");
      }
    }
    const s = n.submit as { as?: string; tool?: string } | undefined;
    if (s?.as === "tool" && !s.tool)
      add(ctx, `${path}.submit.tool`, "submit.as 'tool' needs `tool`.");
  }
  if (type === "link" || (type === "image" && (n.src as { url?: string } | undefined)?.url)) {
    const url = type === "link" ? (n.url as string) : (n.src as { url: string }).url;
    if (!/^(https?:\/\/|mailto:|#|\/)/i.test(url ?? "")) {
      add(
        ctx,
        type === "link" ? `${path}.url` : `${path}.src.url`,
        "Only http(s), mailto, # and relative links are allowed.",
      );
    }
  }
  if (type === "chart") {
    // Series with different point counts render a ragged chart.
    const lens = new Set(
      ((n.series as Array<{ points: unknown[] }>) ?? []).map((s) => s.points.length),
    );
    if (lens.size > 1)
      add(ctx, `${path}.series`, "All series must have the same number of points.");
  }
}

function childLists(type: WidgetNodeType, n: Record<string, unknown>): Array<[string, unknown[]]> {
  if (type === "tabs") {
    return ((n.tabs as Array<{ children?: unknown[] }>) ?? []).map((t, i) => [
      `tabs[${i}].children`,
      t.children ?? [],
    ]);
  }
  if (Array.isArray(n.children)) return [["children", n.children as unknown[]]];
  return [];
}

function walk(ctx: Ctx, raw: unknown, path: string, depth: number): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    add(ctx, path, "A node must be an object { id, type, ...props }.");
    return;
  }
  const n = raw as Record<string, unknown>;
  const type = n.type;
  if (typeof type !== "string" || !(WIDGET_NODE_TYPES as string[]).includes(type)) {
    add(
      ctx,
      `${path}.type`,
      `Unknown node type ${JSON.stringify(type)}. Allowed: ${WIDGET_NODE_TYPES.join(", ")}.`,
    );
    return;
  }
  ctx.count += 1;
  if (ctx.count > WIDGET_LIMITS.nodes) {
    if (ctx.count === WIDGET_LIMITS.nodes + 1)
      add(ctx, path, `More than ${WIDGET_LIMITS.nodes} nodes. Show fewer, or use a table.`);
    return;
  }
  if (depth > WIDGET_LIMITS.depth) {
    add(ctx, path, `Nesting deeper than ${WIDGET_LIMITS.depth} levels. Flatten the layout.`);
    return;
  }
  const t = type as WidgetNodeType;
  // Children are walked as nodes below; the strict schema only checks the shape of the rest.
  for (const err of Value.Errors(WIDGET_NODE_SCHEMAS[t], n)) {
    const p = `${path}${err.path.replace(/\//g, ".")}`;
    add(ctx, p, err.message);
    if (ctx.issues.length >= MAX_ISSUES) break;
  }
  const id = n.id;
  if (typeof id === "string" && Value.Check(WidgetNodeId, id)) {
    if (ctx.ids.has(id))
      add(ctx, `${path}.id`, `Duplicate node id '${id}'. Ids must be unique in the widget.`);
    ctx.ids.add(id);
  }
  checkStrings(ctx, n, path, t);
  reservedCheck(ctx, t, n, path);
  extraChecks(ctx, t, n, path);

  if (n.bind && typeof n.bind === "object") {
    const problem = bindingProblem(n.bind as never, t);
    if (problem !== null) add(ctx, `${path}.bind`, problem);
  }

  const tableRows = t === "table" ? ((n.rows as unknown[] | undefined)?.length ?? 0) : 0;
  if (tableRows > WIDGET_LIMITS.tableRowsStored) {
    add(ctx, `${path}.rows`, `At most ${WIDGET_LIMITS.tableRowsStored} rows.`);
  }

  let buttons = 0;
  for (const [field, list] of childLists(t, n)) {
    list.forEach((c, i) => {
      if (c && typeof c === "object" && (c as { type?: unknown }).type === "button") buttons += 1;
      walk(ctx, c, `${path}.${field}[${i}]`, depth + 1);
    });
  }
  if (buttons > WIDGET_LIMITS.buttonsPerContainer) {
    add(
      ctx,
      path,
      `At most ${WIDGET_LIMITS.buttonsPerContainer} buttons per container; use choices or a list instead.`,
    );
  }
}

/** Validates a full spec. `ok: false` carries at most 20 issues, each with a path. */
export function validateWidgetSpec(spec: unknown): WidgetValidation {
  const ctx: Ctx = { issues: [], ids: new Set(), count: 0 };
  if (!spec || typeof spec !== "object")
    return { ok: false, issues: [{ path: "", message: "Spec must be an object." }] };
  if ((spec as { v?: unknown }).v !== WIDGET_SPEC_VERSION) {
    add(ctx, "v", `Spec version must be ${WIDGET_SPEC_VERSION}.`);
  }
  for (const err of Value.Errors(WidgetSpec, spec)) {
    add(ctx, err.path.replace(/^\//, "").replace(/\//g, ".") || "", err.message);
  }
  let bytes = 0;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(spec)).length;
  } catch {
    add(ctx, "", "Spec is not JSON-serializable.");
  }
  if (bytes > WIDGET_LIMITS.specBytes) {
    add(
      ctx,
      "",
      `Spec is ${bytes} bytes; the limit is ${WIDGET_LIMITS.specBytes}. Show fewer rows or split the widget.`,
    );
  }
  const root = (spec as { root?: unknown }).root;
  if (root !== undefined) walk(ctx, root, "root", 1);
  return ctx.issues.length ? { ok: false, issues: ctx.issues } : { ok: true };
}

export function validateWidgetPatch(patch: unknown): WidgetValidation {
  const issues: WidgetIssue[] = [];
  for (const err of Value.Errors(WidgetPatch, patch)) {
    if (issues.length < MAX_ISSUES)
      issues.push({ path: err.path.replace(/^\//, "").replace(/\//g, "."), message: err.message });
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(patch)).length > WIDGET_LIMITS.patchBytes) {
      issues.push({
        path: "",
        message: `Patch is larger than ${WIDGET_LIMITS.patchBytes} bytes. Send fewer ops.`,
      });
    }
  } catch {
    issues.push({ path: "", message: "Patch is not JSON-serializable." });
  }
  return issues.length ? { ok: false, issues } : { ok: true };
}

/** One line per issue, for a tool error the model reads. */
export function formatWidgetIssues(issues: readonly WidgetIssue[]): string {
  return issues.map((i) => `- ${i.path || "(spec)"}: ${i.message}`).join("\n");
}
