import { createContext } from "react";

/** Facts about the widget being drawn that nodes need (chat for bindings, taint for images). */
export interface WidgetContextValue {
  threadId: string;
  widgetId: string;
  /** The widget was built from untrusted content (§7.3): remote images wait for a click. */
  tainted: boolean;
}

export const WidgetContext = createContext<WidgetContextValue | null>(null);
