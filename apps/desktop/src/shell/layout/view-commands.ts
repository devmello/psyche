import {
  type ErrorPayload,
  type EventPayload,
  PsycheError,
  type ViewLayout,
  type ViewPaneState,
  validateParams,
} from "@psyche/protocol";
import {
  CHAT_PANE_ID,
  findPane,
  type LayoutAction,
  type LayoutEnv,
  type LayoutState,
  latestPaneOfKind,
} from "./model.ts";
import { applyLayoutAction } from "./reducer.ts";

/**
 * `view.command` (Gateway → desktop) → layout actions, and the layout → `view.report`. Bad input
 * becomes an error result for the host to report back; nothing here throws into the UI.
 */

export type ViewCommandPayload = EventPayload<"view.command">;
export type ViewCommandName = ViewCommandPayload["command"];

export type ViewCommandMapping =
  | {
      ok: true;
      commandId: string | null;
      command: ViewCommandName;
      action: LayoutAction;
      /** `view.open`'s `threadId`, when given: the thread whose layout the command targets. */
      threadId: string | null;
    }
  | { ok: false; commandId: string | null; error: ErrorPayload };

export type ViewCommandOutcome =
  | {
      ok: true;
      commandId: string | null;
      command: ViewCommandName;
      state: LayoutState;
      /** The pane acted on; null = the chat column. A popped pane: the host raises its window. */
      paneId: string | null;
      changed: boolean;
    }
  | { ok: false; commandId: string | null; error: ErrorPayload };

const METHODS = { open: "view.open", close: "view.close", focus: "view.focus" } as const;

function fail(
  commandId: string | null,
  code: ErrorPayload["code"],
  message: string,
  details?: unknown,
) {
  const error: ErrorPayload =
    details === undefined ? { code, message } : { code, message, details };
  return { ok: false as const, commandId, error };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Maps a `view.command` payload to a layout action. With `state`, close / focus of a pane that is
 * not there is a `not_found` error instead of a no-op.
 */
export function viewCommandToAction(payload: unknown, state?: LayoutState): ViewCommandMapping {
  if (!isRecord(payload))
    return fail(null, "invalid_params", "view.command payload must be an object");
  const commandId = typeof payload.commandId === "string" ? payload.commandId : null;
  const command = payload.command;
  if (command !== "open" && command !== "close" && command !== "focus") {
    return fail(commandId, "invalid_params", `unknown view command: ${String(command)}`);
  }
  const args = payload.args === undefined ? {} : payload.args;
  if (!isRecord(args))
    return fail(commandId, "invalid_params", "view.command args must be an object");

  try {
    if (command === "open") {
      const p = validateParams("view.open", args);
      const threadId = p.threadId ?? null;
      if (p.pane === "chat") {
        return { ok: true, commandId, command, threadId, action: { type: "focus", paneId: null } };
      }
      const action: LayoutAction = { type: "open", pane: p.pane };
      if (p.placement !== undefined) action.placement = p.placement;
      if (p.target !== undefined) action.target = p.target;
      if (p.threadId !== undefined) action.threadId = p.threadId;
      if (p.taskId !== undefined) action.taskId = p.taskId;
      if (p.artifactId !== undefined) action.artifactId = p.artifactId;
      return { ok: true, commandId, command, threadId, action };
    }

    const ref = validateParams(METHODS[command], args);
    if (ref.paneId === undefined && ref.pane === undefined) {
      return fail(commandId, "invalid_params", `${METHODS[command]} needs paneId or pane`);
    }
    const isChat = ref.paneId === CHAT_PANE_ID || (ref.paneId === undefined && ref.pane === "chat");
    if (isChat) {
      if (command === "close") {
        return fail(commandId, "invalid_params", "the chat column cannot be closed");
      }
      return {
        ok: true,
        commandId,
        command,
        threadId: null,
        action: { type: "focus", paneId: null },
      };
    }
    if (state !== undefined) {
      const found =
        ref.paneId !== undefined
          ? findPane(state, ref.paneId)
          : ref.pane !== undefined
            ? latestPaneOfKind(state, ref.pane)
            : undefined;
      if (found === undefined) {
        const what = ref.paneId !== undefined ? `pane ${ref.paneId}` : `a ${ref.pane} pane`;
        return fail(commandId, "not_found", `no ${what} is open`);
      }
    }
    const target: { paneId?: string; pane?: LayoutState["panes"][number]["pane"] } = {};
    if (ref.paneId !== undefined) target.paneId = ref.paneId;
    else if (ref.pane !== undefined && ref.pane !== "chat") target.pane = ref.pane;
    const action: LayoutAction =
      command === "close" ? { type: "close", ...target } : { type: "focus", ...target };
    return { ok: true, commandId, command, threadId: null, action };
  } catch (err) {
    if (err instanceof PsycheError) return fail(commandId, err.code, err.message, err.details);
    return fail(commandId, "internal", err instanceof Error ? err.message : String(err));
  }
}

/** Maps and applies a `view.command` to one thread's layout. */
export function applyViewCommand(
  state: LayoutState,
  payload: unknown,
  env: LayoutEnv,
): ViewCommandOutcome {
  const mapped = viewCommandToAction(payload, state);
  if (!mapped.ok) return mapped;
  try {
    const out = applyLayoutAction(state, mapped.action, env);
    return {
      ok: true,
      commandId: mapped.commandId,
      command: mapped.command,
      state: out.state,
      paneId: out.paneId,
      changed: out.changed,
    };
  } catch (err) {
    return fail(mapped.commandId, "internal", err instanceof Error ? err.message : String(err));
  }
}

/**
 * The layout as `view.report` sends it: the chat column first (`paneId: "chat"`, placement
 * `main`), then docked panes group by group (first group `side`, later groups `split`), then
 * popped panes (placement `main`: each fills its own window). `focusedPaneId` is `"chat"` when
 * the chat column has focus.
 */
export function toViewLayout(state: LayoutState, now: string | (() => string)): ViewLayout {
  const panes: ViewPaneState[] = [
    {
      paneId: CHAT_PANE_ID,
      pane: "chat",
      placement: "main",
      threadId: state.threadId,
      target: null,
    },
  ];
  const entry = (paneId: string, placement: ViewPaneState["placement"]): ViewPaneState | null => {
    const p = findPane(state, paneId);
    if (p === undefined) return null;
    return { paneId, pane: p.pane, placement, threadId: p.threadId, target: p.target };
  };
  state.groups.forEach((g, i) => {
    for (const id of g.paneIds) {
      const e = entry(id, i === 0 ? "side" : "split");
      if (e !== null) panes.push(e);
    }
  });
  for (const id of state.popped) {
    const e = entry(id, "main");
    if (e !== null) panes.push(e);
  }
  return {
    panes,
    focusedPaneId: state.focusedPaneId ?? CHAT_PANE_ID,
    updatedAt: typeof now === "string" ? now : now(),
  };
}
