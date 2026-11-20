import type { WidgetBind } from "./schemas/widgets.ts";

/**
 * What a widget node may bind to (generative-ui-2026 §5.4). `bind: {source, id, field}` lets the
 * host keep a node current from an entity it already tracks, with no model tokens and no stored
 * patches. The table is closed: a field not listed for a source, or on a node type not listed for
 * that field, is rejected by `validateWidgetSpec`. The renderer maps each pair to node props.
 */
export const WIDGET_BINDINGS = {
  /** A background task (`task.updated`). */
  task: {
    status: ["status", "text"],
    progress: ["progress"],
    steps: ["checklist"],
    title: ["text"],
    summary: ["text"],
  },
  /** One tool call (`tool_call.updated`). */
  tool_call: {
    status: ["status", "text"],
  },
  /** A deep-research tool call (`research.progress`); `id` is the tool call id. */
  research: {
    progress: ["progress"],
    status: ["status", "text"],
    claims: ["stat", "text"],
    sources: ["stat", "text"],
  },
  /** A scheduled automation (`automation.updated`). */
  automation: {
    status: ["status", "text"],
    nextRun: ["text", "stat"],
    lastRun: ["text", "stat"],
  },
  /** A background specialist job, by its task id (`specialist.*`). */
  job: {
    status: ["status", "text"],
    lastStep: ["text"],
  },
  /**
   * Spaces query sources (spaces-2026 section 6.2). The Gateway re-runs a typed, closed query on
   * free signals and writes the result into the node (no model call). `id` is the Space's id,
   * except for `entity`, where it is the linked project or one of its children.
   */
  entity: {
    status: ["status", "text"],
    nextStep: ["text"],
    stoppedAt: ["text"],
    due: ["text", "stat"],
  },
  work_due: {
    count: ["stat", "text"],
    next: ["checklist"],
  },
  calendar: {
    next: ["checklist"],
    countWeek: ["stat", "text"],
  },
  reminders: {
    open: ["stat", "text"],
    done: ["stat", "text"],
    nextDue: ["text"],
  },
  mail: {
    unread: ["stat", "text"],
    latest: ["checklist"],
  },
  files: {
    recent: ["checklist"],
    count: ["stat", "text"],
  },
} as const satisfies Record<WidgetBind["source"], Record<string, readonly string[]>>;

/** The sources whose values the Gateway computes from a Space's own data (spaces-2026 section 6.2). */
export const SPACE_QUERY_SOURCES = [
  "entity",
  "work_due",
  "calendar",
  "reminders",
  "mail",
  "files",
] as const;
export type SpaceQuerySource = (typeof SPACE_QUERY_SOURCES)[number];

export const isSpaceQuerySource = (s: string): s is SpaceQuerySource =>
  (SPACE_QUERY_SOURCES as readonly string[]).includes(s);

/** `null` when `bind` may sit on a node of `nodeType`, else why not (for the model). */
export function bindingProblem(bind: WidgetBind, nodeType: string): string | null {
  const fields = WIDGET_BINDINGS[bind.source] as Record<string, readonly string[]> | undefined;
  if (fields === undefined) {
    return `'${String(bind.source)}' is not a bindable source. Allowed: ${Object.keys(WIDGET_BINDINGS).join(", ")}.`;
  }
  const allowed = fields[bind.field];
  if (allowed === undefined) {
    return `'${bind.field}' is not a bindable field of ${bind.source}. Allowed: ${Object.keys(fields).join(", ")}.`;
  }
  if (!allowed.includes(nodeType)) {
    return `${bind.source}.${bind.field} can only bind to a ${allowed.join(" or ")} node, not ${nodeType}.`;
  }
  return null;
}

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => !!v && typeof v === "object" && !Array.isArray(v);

/** Every binding in a spec, with the id of the node that carries it. */
export function collectWidgetBinds(root: unknown): Array<{ nodeId: string; bind: WidgetBind }> {
  const out: Array<{ nodeId: string; bind: WidgetBind }> = [];
  const walk = (n: unknown, depth: number): void => {
    if (!isNode(n) || depth > 12) return;
    if (isNode(n.bind)) out.push({ nodeId: String(n.id), bind: n.bind as unknown as WidgetBind });
    if (Array.isArray(n.children)) for (const c of n.children) walk(c, depth + 1);
    if (Array.isArray(n.tabs)) {
      for (const t of n.tabs) {
        if (isNode(t) && Array.isArray(t.children)) for (const c of t.children) walk(c, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}
