import type { Notification } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationRelay, PRESENCE_HOLD_MS } from "../src/lib/notify-relay.ts";

const base: Notification = {
  id: "01JBXY6Q8Z0000000000000009",
  kind: "approval",
  title: "Approval needed",
  body: "Send an email",
  taskId: null,
  approvalId: "01JBXY6Q8Z0000000000000010",
  route: null,
  actions: [{ id: "approve", label: "Approve" }],
  surfaces: ["desktop", "notification"],
  delivered: {},
  readAt: null,
  resolvedAt: null,
  createdAt: "2026-11-24T10:00:00.000Z",
};

describe("notifications while the first helper presence check is pending", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the toast, then drops it when the helper turns out to deliver it", () => {
    const r = new NotificationRelay();
    const shown: string[] = [];
    r.offer(base, (d) => d.show && shown.push(d.title ?? ""));
    // Nothing shows while presence is pending.
    expect(shown).toEqual([]);
    r.setPresence(true);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(PRESENCE_HOLD_MS * 2);
    expect(shown).toEqual([]);
  });

  it("shows the toast once when no helper is online, and never twice for the same id", () => {
    const r = new NotificationRelay();
    const shown: string[] = [];
    const show = (d: { show: boolean; title?: string }) => d.show && shown.push(d.title ?? "");
    r.offer(base, show);
    r.setPresence(false);
    expect(shown).toEqual(["Approval needed"]);
    // A later event for the same notification does not toast again.
    r.offer(base, show);
    expect(shown).toEqual(["Approval needed"]);
  });

  it("decides on its own after the hold when presence never lands", () => {
    const r = new NotificationRelay();
    const shown: string[] = [];
    r.offer(base, (d) => d.show && shown.push(d.title ?? ""));
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(PRESENCE_HOLD_MS);
    expect(shown).toEqual(["Approval needed"]);
  });

  it("decides at once once presence is known", () => {
    const r = new NotificationRelay();
    r.setPresence(true);
    const shown: string[] = [];
    r.offer(base, (d) => d.show && shown.push(d.title ?? ""));
    expect(shown).toEqual([]);
  });
});
