import { createContext } from "react";

/** Facts about the widget being drawn that nodes need (chat for bindings, taint for images). */
export interface WidgetContextValue {
  threadId: string;
  widgetId: string;
  /** The widget was built from untrusted content (§7.3): remote images wait for a click. */
  tainted: boolean;
  /**
   * Where it is drawn. `chat` is the full widget; `overview` (pinned) and `feed` (a static
   * snapshot, D8) draw it without answer, tool, form or choice controls: only `open` and `reply`
   * remain, and a reply there fills the composer for the owner to send (generative-ui-2026 §8).
   * A feed snapshot has no bindings and no remote images.
   */
  surface: "chat" | "feed" | "overview";
}

export const WidgetContext = createContext<WidgetContextValue | null>(null);
