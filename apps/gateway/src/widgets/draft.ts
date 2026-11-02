import { WIDGET_DRAFT_TOOLS, widgetDraft } from "@psyche/protocol";

/**
 * Throwaway previews of a `render_ui` spec while the model writes it (generative-ui-2026 §5.5,
 * P9). It keeps the input text per call, reads it at most every `MIN_GAP_MS`, and publishes the
 * nodes that are complete and valid so far, only when something new showed up. Nothing here is
 * stored: the committed widget replaces the draft, and `finish` tells the client to drop it.
 */
export interface DraftFrame {
  threadId: string;
  messageId: string;
  callId: string;
  title?: string;
  root?: Record<string, unknown>;
  nodes: number;
  done?: boolean;
}

const MIN_GAP_MS = 250;

export function createDraftStreamer(options: {
  publish: (frame: DraftFrame) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const calls = new Map<
    string,
    { text: string; at: number; sent: string; threadId: string; messageId: string }
  >();
  return {
    /** One piece of a tool's input. Tools that do not draw progressively are ignored. */
    input(e: {
      threadId: string;
      messageId: string;
      callId: string;
      tool: string;
      delta: string;
    }): void {
      if (!WIDGET_DRAFT_TOOLS.includes(e.tool)) return;
      const c = calls.get(e.callId) ?? {
        text: "",
        at: Number.NEGATIVE_INFINITY,
        sent: "",
        threadId: e.threadId,
        messageId: e.messageId,
      };
      c.text += e.delta;
      calls.set(e.callId, c);
      const t = now();
      if (t - c.at < MIN_GAP_MS) return;
      c.at = t;
      const d = widgetDraft(c.text);
      const key = `${d.title ?? ""}\u0000${d.nodes}`;
      if (key === c.sent) return;
      c.sent = key;
      options.publish({
        threadId: c.threadId,
        messageId: c.messageId,
        callId: e.callId,
        nodes: d.nodes,
        ...(d.title === undefined ? {} : { title: d.title }),
        ...(d.root === undefined ? {} : { root: d.root }),
      });
    },
    /** The call's input is complete (or the run ended): the client drops the preview. */
    finish(callId: string): void {
      const c = calls.get(callId);
      if (c === undefined) return;
      calls.delete(callId);
      options.publish({
        threadId: c.threadId,
        messageId: c.messageId,
        callId,
        nodes: 0,
        done: true,
      });
    },
    /** A thread's run is over: no preview of it may linger. */
    finishThread(threadId: string): void {
      for (const [id, c] of [...calls]) if (c.threadId === threadId) this.finish(id);
    },
  };
}
