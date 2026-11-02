import { WIDGET_LIMITS } from "./schemas/widgets.ts";
import { validateWidgetSpec } from "./widgets-validate.ts";

/**
 * Progressive rendering (generative-ui-2026 §5.5, P9). While the model writes a `render_ui`
 * input, the Gateway reads the text so far and shows only what is already complete: a node counts
 * once its object has closed, never half of it. The draft is a throwaway preview: the committed
 * spec (validated whole, stored) replaces it, and a draft that does not validate is dropped.
 */

/** Tools whose streaming input is read for drafts. */
export const WIDGET_DRAFT_TOOLS: readonly string[] = ["render_ui"];

/** Cap on the text read, so a runaway input costs nothing here (the validator has the real limit). */
const MAX_DRAFT_CHARS = WIDGET_LIMITS.specBytes * 2;

interface Partial {
  value: unknown;
  closed: boolean;
}

/** Objects and arrays whose closing bracket has arrived. */
const finished = new WeakSet<object>();

/** A tolerant reader of JSON that may stop anywhere: every value says whether it was finished. */
function read(text: string): Partial | undefined {
  let i = 0;
  const ws = (): void => {
    while (i < text.length && " \n\r\t".includes(text[i] as string)) i++;
  };
  const string = (): { s: string; closed: boolean } | undefined => {
    const start = i;
    i++; // opening quote
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        try {
          return { s: JSON.parse(text.slice(start, i)) as string, closed: true };
        } catch {
          return undefined;
        }
      }
      i++;
    }
    return { s: "", closed: false };
  };
  const value = (depth: number): Partial | undefined => {
    ws();
    if (i >= text.length || depth > WIDGET_LIMITS.depth + 2) return undefined;
    const c = text[i];
    if (c === '"') {
      const r = string();
      return r === undefined ? undefined : { value: r.s, closed: r.closed };
    }
    if (c === "{") {
      i++;
      const out: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (i >= text.length) return { value: out, closed: false };
        if (text[i] === "}") {
          i++;
          finished.add(out);
          return { value: out, closed: true };
        }
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] !== '"') return undefined;
        const key = string();
        if (key === undefined || !key.closed) return { value: out, closed: false };
        ws();
        if (text[i] !== ":") return i >= text.length ? { value: out, closed: false } : undefined;
        i++;
        const v = value(depth + 1);
        if (v === undefined) return i >= text.length ? { value: out, closed: false } : undefined;
        // Only whole values are kept, except containers, which carry their closed parts.
        if (v.closed || typeof v.value === "object") out[key.s] = v.value;
        if (!v.closed) return { value: out, closed: false };
      }
    }
    if (c === "[") {
      i++;
      const out: unknown[] = [];
      for (;;) {
        ws();
        if (i >= text.length) return { value: out, closed: false };
        if (text[i] === "]") {
          i++;
          finished.add(out);
          return { value: out, closed: true };
        }
        if (text[i] === ",") {
          i++;
          continue;
        }
        const v = value(depth + 1);
        if (v === undefined) return i >= text.length ? { value: out, closed: false } : undefined;
        if (v.closed) out.push(v.value);
        else return { value: out, closed: false };
      }
    }
    // A number or literal: finished only when something follows it.
    const start = i;
    while (i < text.length && !",}] \n\r\t".includes(text[i] as string)) i++;
    if (i >= text.length) return { value: undefined, closed: false };
    const raw = text.slice(start, i);
    try {
      return { value: JSON.parse(raw), closed: true };
    } catch {
      return undefined;
    }
  };
  return value(0);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The part of a node that is complete: a finished node as it is; an unfinished container as its
 * closed scalar fields plus the finished nodes among its `children`. Anything else is nothing.
 */
function complete(node: unknown): Record<string, unknown> | undefined {
  if (!isObject(node)) return undefined;
  if (finished.has(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "children") continue;
    if (v !== null && typeof v !== "object") out[k] = v;
  }
  if (typeof out.id !== "string" || typeof out.type !== "string") return undefined;
  const kids = node.children;
  if (Array.isArray(kids)) out.children = kids; // the reader already kept only closed ones
  return out;
}

/** Nodes a preview never draws: anything clickable, anything that fetches. */
const INERT_DROP = new Set(["button", "choices", "form", "link", "image", "map"]);

/**
 * A preview is read-only: no controls, no pictures, no live bindings, no row actions. Whatever the
 * model wrote there arrives in the committed widget, behind the host's frame and checks.
 */
function inert(node: Record<string, unknown>): Record<string, unknown> | undefined {
  if (INERT_DROP.has(node.type as string)) return undefined;
  const { action: _a, bind: _b, ...rest } = node;
  if (Array.isArray(rest.children)) {
    rest.children = rest.children.flatMap((c) =>
      isObject(c) ? (inert(c) === undefined ? [] : [inert(c)]) : [],
    );
  }
  if (Array.isArray(rest.items)) {
    rest.items = rest.items.map((i) => {
      if (!isObject(i)) return i;
      const { action: _x, ...row } = i;
      return row;
    });
  }
  return rest;
}

export interface WidgetDraft {
  title?: string;
  /** The complete nodes so far under the root; absent while nothing valid has arrived. */
  root?: Record<string, unknown>;
  /** Finished nodes counted, for a skeleton that grows. */
  nodes: number;
}

const count = (node: unknown): number =>
  isObject(node)
    ? 1 +
      (Array.isArray(node.children) ? node.children.reduce<number>((n, c) => n + count(c), 0) : 0)
    : 0;

/**
 * The draft for the model's input text so far. Never throws; returns `{ nodes: 0 }` for anything
 * it cannot make sense of or that would not validate as a widget.
 */
export function widgetDraft(text: string): WidgetDraft {
  if (text.length > MAX_DRAFT_CHARS) return { nodes: 0 };
  const top = read(text);
  if (top === undefined || !isObject(top.value)) return { nodes: 0 };
  const title =
    typeof top.value.title === "string" && top.value.title.length > 0
      ? top.value.title.slice(0, 80)
      : undefined;
  const base: WidgetDraft = { nodes: 0, ...(title === undefined ? {} : { title }) };
  const rootRaw = top.value.root;
  const whole = complete(rootRaw);
  if (whole === undefined) return base;
  const probe = {
    v: top.value.v ?? 1,
    title: title ?? "Widget",
    fallbackText: "Widget",
    root: whole,
  };
  // What is shown is the validated tree minus its controls, so a rejected node never appears.
  if (!validateWidgetSpec(probe).ok) return base;
  const root = inert(whole);
  if (root === undefined) return base;
  return { ...base, root, nodes: count(root) };
}
