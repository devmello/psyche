import {
  type AgentToolRegistration,
  defineTool,
  type ToolRunContext,
  type TurnToolContext,
} from "@psyche/agent-core";
import {
  PsycheError,
  type TaintSource,
  type ToolResult,
  type WidgetOwner,
  WidgetPatch,
  WidgetSpec,
} from "@psyche/protocol";
import { Type } from "@sinclair/typebox";
import type { WidgetStore } from "./store.ts";

/**
 * `render_ui`, `update_ui`, `list_ui` (generative-ui-2026 §5.2, §6.4). Typed input with
 * validation errors the model can act on (D1). Taint is attached here, from the turn, whether or
 * not the model says the content came from an untrusted source (§7.3).
 */

const CATALOGUE =
  'Nodes (every node has a unique id like "steps" and a type): ' +
  "progress {label, value, max | indeterminate, steps?[{label,state}]}; checklist {items:[{id,label,state: todo|active|done|skipped|failed, detail?}]}; " +
  "timeline {entries:[{id,time?,label,tone?}]}; status {label,tone}; stat {label,value,unit?,delta?,tone?}; kv {rows:[{label,value}]}; " +
  "table {label,columns:[{key,label,type?: text|number|date|link}],rows:[{key:value}],sortable?}; text {text,emphasis?,tone?}; markdown {md}; code {code,language?}; link {label,url}; " +
  "card {title?,subtitle?,tone?,children}; list {items:[{id,title,meta?}]}; stack {direction?,gap?,children}; grid {columns:2-4,children}; tabs {tabs:[{id,label,children}]}. " +
  "tone is neutral|info|success|warning|danger. No colours, classes, HTML or scripts exist; unknown fields are rejected. " +
  "(chart, image, map, button, choices and form are accepted but not drawn yet; do not rely on them.)";

const RENDER_DESCRIPTION =
  "Show a small live widget in the chat: use it for state (progress, a task list, a status that will change), structure (more than about 4 comparable items, numbers worth scanning) or a choice. " +
  'Write text instead for explanations, opinions, short facts or anything the owner will quote. One widget per purpose, compact, titled, no decoration, and never introduce it in text (no "here is a widget"). ' +
  "Prefer updating an existing widget with update_ui over drawing a new one. Always write a real fallbackText (a one-line summary used by channels and screen readers). " +
  "Approvals are host-owned: never title or style a widget as an approval or permission request. " +
  `Spec: {v:1,title,fallbackText,root:<node>}. ${CATALOGUE} Limits: 32 KB, 200 nodes, depth 8, strings 500 chars. Returns {widgetId, rev}.`;

const UPDATE_DESCRIPTION =
  'Patch a widget you drew in this chat, by node id: {op:"set",id,props} merges props into a node (or a checklist/list item with that id); {op:"append"|"prepend",id,field,items} adds to a list-like field (items, rows, entries, children...); {op:"remove",id}; {op:"replace",id,node}; {op:"meta",title?,fallbackText?}. ' +
  "Pass baseRev from the last rev you saw to avoid overwriting a change. Keep fallbackText current when the numbers change. Only widgets of this chat can be patched; a frozen widget cannot.";

const LIST_DESCRIPTION =
  "List the widgets in this chat (id, title, rev, live or frozen, summary), most recently patched first, so you can update_ui one.";

const RenderInput = Type.Object({ spec: WidgetSpec }, { additionalProperties: false });
const ListInput = Type.Object({}, { additionalProperties: false });

const toolError = (e: unknown): ToolResult => {
  const err = e instanceof PsycheError ? e : new PsycheError("internal", String(e));
  return {
    output: { error: { code: err.code, message: err.message } },
    isError: true,
    provenance: "trusted",
  };
};

/** The turn's taint as a list: the sources the loop tracked, or a generic one when it only knows "tainted". */
export function turnTaint(ctx: ToolRunContext): TaintSource[] {
  if (ctx.taintSources !== undefined && ctx.taintSources.length > 0) return [...ctx.taintSources];
  return ctx.taint ? [{ sourceKind: "turn" }] : [];
}

export function widgetTools(store: WidgetStore): AgentToolRegistration[] {
  return [
    defineTool({
      name: "render_ui",
      description: RENDER_DESCRIPTION,
      input: RenderInput,
      sideEffect: "none",
      describeCall: (p) => ({ summary: `Showed widget "${p.spec.title}"` }),
      run: async (p, ctx) => {
        try {
          const turn = (ctx as Partial<TurnToolContext>).turn;
          if (turn === undefined) throw new PsycheError("internal", "render_ui runs inside a turn");
          const owner: WidgetOwner =
            ctx.taskId === undefined
              ? { kind: "run", runId: ctx.runId }
              : { kind: "task", taskId: ctx.taskId };
          const w = store.create({
            threadId: ctx.threadId,
            messageId: turn.messageId(),
            spec: p.spec,
            taint: turnTaint(ctx),
            owner,
          });
          turn.emitBlock({ type: "ui", widgetId: w.id });
          return { output: { widgetId: w.id, rev: w.rev }, provenance: "trusted" };
        } catch (e) {
          return toolError(e);
        }
      },
    }),
    defineTool({
      name: "update_ui",
      description: UPDATE_DESCRIPTION,
      input: WidgetPatch,
      sideEffect: "none",
      describeCall: (p) => ({ summary: `Updated widget (${p.ops.length} ops)` }),
      run: async (p, ctx) => {
        try {
          const w = store.patch({
            widgetId: p.widgetId,
            threadId: ctx.threadId,
            ...(p.baseRev === undefined ? {} : { baseRev: p.baseRev }),
            ops: p.ops,
            taint: turnTaint(ctx),
          });
          return { output: { widgetId: w.id, rev: w.rev }, provenance: "trusted" };
        } catch (e) {
          return toolError(e);
        }
      },
    }),
    defineTool({
      name: "list_ui",
      description: LIST_DESCRIPTION,
      input: ListInput,
      sideEffect: "none",
      describeCall: () => ({ summary: "Listed widgets" }),
      run: async (_p, ctx) => ({
        output: { widgets: store.list(ctx.threadId) },
        provenance: "trusted",
      }),
    }),
  ];
}
