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
  "Live: a progress, checklist, status, stat or text node may carry bind:{source,id,field} and the app keeps it current with no tokens: task (status, progress, steps, title, summary), tool_call (status), research (progress, status, claims, sources; id is the research tool call id), automation (status, nextRun, lastRun), job (status, lastStep). Prefer bind over update_ui for anything the app already tracks; only things of this chat can be bound. " +
  "chart {label,kind: bar|line|sparkline,unit?,series:[{name,points:[{x,y}]}] (max 4 series, same point count)}; image {alt,src:{fileId}|{dataUrl}|{url: https}} (remote urls are off unless the owner allows them: prefer a fileId); map {label,places:[{name,address?,lat?,lng?}]} (a place list with Open in Maps, no tiles). " +
  'Interaction (every click is the owner\'s; nothing fires by itself): button {label,action}; choices {label,mode: single|multi,options:[{id,label}],action}; form {label,fields:[{id,label,type: text|textarea|number|select|toggle|date,required?,options?}],submit:{label,as:"reply",template?}}; list items may carry an action. Actions: {kind:"reply",text} sends text as the owner\'s message (shown in the chat with a "from widget" chip); {kind:"answer",inputRequestId,value} answers one of your open ask_user questions with one of its offered option labels; {kind:"open",route|artifactId|fileId|url}; {kind:"tool",tool,args} proposes ONE tool call when clicked (also a form with submit.as "tool" and submit.tool, whose args are the typed field values, and list rows): it goes through the same permission checks as if you had called the tool, the owner sees the call and its arguments in the chat, and the control says "Asks you first" when a card would appear. Never propose request_permission, install_capability, run_script, save_script_as_tool or exit_plan_mode this way. Not yet available: choices with ask:true. Never label a control Allow, Approve, Deny or Grant: approvals are host-owned and answered only by the app\'s own cards.';

const RENDER_DESCRIPTION =
  "Show a small live widget in the chat: use it for state (progress, a task list, a status that will change), structure (more than about 4 comparable items, numbers worth scanning) or a choice. " +
  'Write text instead for explanations, opinions, short facts or anything the owner will quote. One widget per purpose, compact, titled, no decoration, and never introduce it in text (no "here is a widget"). ' +
  "Prefer updating an existing widget with update_ui over drawing a new one, but when none exists (list_ui is empty) draw it: a request to track or show progress of something starts with a progress or checklist widget made from what you already know (steps as todo, or indeterminate progress), not with a question. Always write a real fallbackText (a one-line summary used by channels and screen readers). " +
  "Approvals are host-owned: never title or style a widget as an approval or permission request. " +
  `Spec: {v:1,title,fallbackText,root:<node>}. ${CATALOGUE} Limits: 32 KB, 200 nodes, depth 8, strings 500 chars. Returns {widgetId, rev}.`;

const UPDATE_DESCRIPTION =
  'Patch a widget you drew in this chat, by node id: {op:"set",id,props} merges props into a node (or a checklist/list item with that id); {op:"append"|"prepend",id,field,items} adds to a list-like field (items, rows, entries, children...); {op:"remove",id}; {op:"replace",id,node}; {op:"meta",title?,fallbackText?}. ' +
  "Pass baseRev from the last rev you saw to avoid overwriting a change. Keep fallbackText current when the numbers change. Only widgets of this chat can be patched; a frozen widget cannot.";

const LIST_DESCRIPTION =
  "List the widgets in this chat (id, title, rev, live or frozen, summary), most recently patched first, so you can update_ui one. An empty list is not an answer: it means there is nothing to patch, so draw a new widget with render_ui if the request is for something to track or show.";

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
