import type { FeedPost, FeedWidget } from "@psyche/protocol";
import { interactiveSpec } from "./fixtures-interactive.ts";

/** A feed snapshot dressed with every control kind; the Feed must draw open and reply only. */
export const feedWidget: FeedWidget = {
  spec: {
    ...interactiveSpec,
    title: "Trip summary",
    fallbackText: "Trip summary: 3 of 5 booked.",
    root: {
      id: "root",
      type: "stack",
      gap: "sm",
      children: [
        {
          id: "p",
          type: "progress",
          label: "Booked",
          value: 3,
          max: 5,
          bind: { source: "task", id: "task_dentist", field: "progress" },
        },
        {
          id: "reply",
          type: "button",
          label: "Ask about the rest",
          action: { kind: "reply", text: "What is still open on the trip?" },
        },
        {
          id: "open",
          type: "button",
          label: "Open calendar",
          action: { kind: "open", route: "/scheduled" },
        },
        {
          id: "tool",
          type: "button",
          label: "Book now",
          action: { kind: "tool", tool: "book", args: {} },
        },
        {
          id: "ans",
          type: "button",
          label: "Tuesday",
          action: { kind: "answer", inputRequestId: "ir_1", value: "Tuesday" },
        },
        {
          id: "pick",
          type: "choices",
          label: "Which?",
          mode: "single",
          options: [{ id: "a", label: "A" }],
          action: { kind: "reply", text: "Pick" },
        },
        {
          id: "img",
          type: "image",
          alt: "Hotel photo",
          src: { url: "https://img.example/hotel.png" },
        },
      ],
    },
  },
  taint: [{ sourceKind: "web", origin: "https://travel.example" }],
};

export const withFeedWidget = (post: FeedPost): FeedPost => ({ ...post, widget: feedWidget });
