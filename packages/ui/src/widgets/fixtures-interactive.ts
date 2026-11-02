import type { Widget, WidgetSpec } from "@psyche/protocol";
import { progressWidget } from "./fixtures.ts";

const widget = (id: string, spec: WidgetSpec, over: Partial<Widget> = {}): Widget => ({
  ...progressWidget,
  id,
  threadId: "th_dentist",
  spec,
  taint: [],
  ...over,
});

export const interactiveSpec: WidgetSpec = {
  v: 1,
  title: "Next step",
  fallbackText: "Choose what to do next.",
  root: {
    id: "root",
    type: "stack",
    gap: "md",
    children: [
      {
        id: "go",
        type: "button",
        label: "Draft the replies now",
        action: { kind: "reply", text: "Draft the replies now" },
      },
      {
        id: "pick",
        type: "choices",
        label: "Which slot?",
        mode: "single",
        options: [
          { id: "a", label: "Tue 2:30" },
          { id: "b", label: "Wed 9:00" },
        ],
        action: { kind: "reply", text: "Book" },
      },
      {
        id: "note",
        type: "form",
        label: "Add a note",
        fields: [
          { id: "name", label: "Name", type: "text", required: true },
          { id: "msg", label: "Message", type: "textarea" },
          { id: "vip", label: "Priority", type: "toggle" },
        ],
        submit: { label: "Send note", as: "reply", template: "Note for the booking" },
      },
      {
        id: "rows",
        type: "list",
        items: [
          { id: "r1", title: "Open my calendar", action: { kind: "open", route: "/scheduled" } },
          { id: "r2", title: "Plain row" },
        ],
      },
      {
        id: "tool",
        type: "button",
        label: "Run it",
        action: { kind: "tool", tool: "send_email", args: {} },
      },
    ],
  },
};

export const interactiveWidget = widget("wdg_interactive", interactiveSpec);
export const interactiveTaintedWidget = widget("wdg_interactive_t", interactiveSpec, {
  taint: [{ sourceKind: "web", origin: "https://news.example.com" }],
});
