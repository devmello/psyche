import type { Widget } from "@psyche/protocol";
import { progressWidget } from "./fixtures.ts";

/** A widget whose nodes are bound to a task of the chat (generative-ui-2026 §5.4). */
export const boundWidget = (taskId: string, threadId: string): Widget => ({
  ...progressWidget,
  id: "wdg_bound",
  threadId,
  spec: {
    v: 1,
    title: "Dentist booking",
    fallbackText: "Dentist booking in progress.",
    root: {
      id: "root",
      type: "stack",
      gap: "sm",
      children: [
        {
          id: "st",
          type: "status",
          label: "Status",
          tone: "neutral",
          bind: { source: "task", id: taskId, field: "status" },
        },
        {
          id: "p",
          type: "progress",
          label: "Booking",
          indeterminate: true,
          bind: { source: "task", id: taskId, field: "progress" },
        },
        {
          id: "steps",
          type: "checklist",
          items: [],
          bind: { source: "task", id: taskId, field: "steps" },
        },
        {
          id: "sum",
          type: "text",
          text: "",
          bind: { source: "task", id: taskId, field: "summary" },
        },
      ],
    },
  },
});
