import { resolveAppRoute, type WidgetAction } from "@psyche/protocol";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePrefillComposer } from "../chat/prefill.ts";
import { useStore } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { useSlots } from "../slots.tsx";
import { WidgetContext } from "./context.ts";

/**
 * What a widget control does when the owner clicks it (generative-ui-2026 §6). Nothing here runs
 * on render, on a timer or on focus: `run` is called from a click or Enter on a host-drawn
 * control, and the renderer, not the spec, decides what the gesture does:
 *
 * - `reply`: sends the text as the owner's message with `fromWidget`, so it shows in the transcript
 *   with a "from widget" chip (D10) and an untrusted widget taints the turn it starts (§7.3).
 * - `answer`: answers an open question of this chat, only with one of the options Psyche really
 *   asked about; it never touches an approval (there is no route from here to `approvals.answer`).
 * - `open`: an app route the app knows, or a Library item or artifact of this owner. Links go
 *   through `SafeLink` (the owner's link policy, which asks for a new origin), never from here.
 * - `tool` (D2): `widgets.act` proposes the call stored in the spec to the agent loop, through the
 *   Permission Broker with the widget's taint; the click is a proposal, never an execution.
 *
 * One action per click, with a 1 s cool-down (§7.5), so a widget cannot become a message cannon.
 */

export type ActionState = "idle" | "working" | "sent";

/** What a click adds to its action: the text it composed, or the control that proposes a call. */
export interface ActionOptions {
  /** `reply`: the composed message instead of the spec's own text. */
  text?: string;
  /** `tool`: the control (and list row) whose stored call is proposed, plus typed form values. */
  nodeId?: string;
  itemId?: string;
  values?: Record<string, string | number | boolean>;
}

export interface ActionRunner {
  state: ActionState;
  error: string | null;
  run: (action: WidgetAction, options?: ActionOptions) => Promise<void>;
}

const COOLDOWN_MS = 1000;

/** The single-question open request a widget answer may address, with its offered labels. */
async function openQuestion(
  store: ReturnType<typeof useStore>,
  inputRequestId: string,
  threadId: string,
) {
  const { inputRequest } = await store.call("questions.get", { inputRequestId });
  const q = inputRequest.questions[0];
  if (inputRequest.status !== "open" || inputRequest.threadId !== threadId || q === undefined) {
    throw new Error(t("widgets.action.questionGone"));
  }
  return { header: q.header, labels: q.options.map((o) => o.label), multi: q.multiSelect };
}

export function useWidgetAction(): ActionRunner {
  const store = useStore();
  const ctx = useContext(WidgetContext);
  const { navigate, openArtifact, openLibraryItem } = useSlots();
  const prefill = usePrefillComposer();
  const [state, setState] = useState<ActionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busy = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);

  const run = useCallback(
    async (action: WidgetAction, options: ActionOptions = {}) => {
      if (ctx === null || busy.current) return;
      busy.current = true;
      setError(null);
      setState("working");
      try {
        if (ctx.surface !== "chat" && action.kind !== "reply" && action.kind !== "open") {
          throw new Error(t("widgets.action.unavailable"));
        }
        if (action.kind === "reply" && ctx.surface !== "chat") {
          // Feed and Overview have no open chat of their own: the text waits in the composer.
          if (prefill === undefined) throw new Error(t("widgets.action.unavailable"));
          prefill(options.text ?? action.text);
        } else if (action.kind === "reply") {
          await store.call("chat.send", {
            threadId: ctx.threadId,
            content: options.text ?? action.text,
            fromWidget: { widgetId: ctx.widgetId },
          });
        } else if (action.kind === "answer") {
          const q = await openQuestion(store, action.inputRequestId, ctx.threadId);
          const values = Array.isArray(action.value) ? action.value : [action.value];
          if (values.length === 0 || values.some((v) => !q.labels.includes(v))) {
            throw new Error(t("widgets.action.notOffered"));
          }
          if (values.length > 1 && !q.multi) throw new Error(t("widgets.action.notOffered"));
          await store.call("questions.answer", {
            inputRequestId: action.inputRequestId,
            answer: { [q.header]: q.multi ? values : (values[0] as string) },
          });
        } else if (action.kind === "open") {
          if (action.route !== undefined) {
            const route = resolveAppRoute(action.route);
            if (route === null || navigate === undefined)
              throw new Error(t("widgets.action.unavailable"));
            navigate(route);
          } else if (action.artifactId !== undefined) {
            const { artifact } = await store.call("artifacts.get", {
              artifactId: action.artifactId,
            });
            if (openArtifact === undefined) throw new Error(t("widgets.action.unavailable"));
            openArtifact(artifact);
          } else if (action.fileId !== undefined) {
            const { item } = await store.call("library.get", { itemId: action.fileId });
            if (openLibraryItem === undefined) throw new Error(t("widgets.action.unavailable"));
            openLibraryItem(item);
          } else {
            throw new Error(t("widgets.action.unavailable"));
          }
        } else if (action.kind === "tool") {
          // The call and its arguments come from the stored spec on the Gateway; this request
          // names only the control and what the owner typed. The broker then decides it like a
          // model's call, and an approval card appears in the dock when it asks.
          if (options.nodeId === undefined) throw new Error(t("widgets.action.unavailable"));
          await store.call("widgets.act", {
            widgetId: ctx.widgetId,
            nodeId: options.nodeId,
            ...(options.itemId === undefined ? {} : { itemId: options.itemId }),
            ...(options.values === undefined ? {} : { values: options.values }),
          });
        }
        setState("sent");
      } catch (e) {
        const message = e instanceof Error && !("code" in e) ? e.message : describeError(e);
        const code = (e as { code?: string }).code;
        setError(
          code === "conflict"
            ? t("widgets.action.busy")
            : t("widgets.action.failed", { reason: message }),
        );
        setState("idle");
      } finally {
        timer.current = setTimeout(() => {
          busy.current = false;
          setState((s) => (s === "sent" ? "idle" : s));
        }, COOLDOWN_MS);
      }
    },
    [ctx, store, navigate, openArtifact, openLibraryItem, prefill],
  );

  return { state, error, run };
}
