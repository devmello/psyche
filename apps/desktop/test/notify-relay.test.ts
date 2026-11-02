import type { Notification } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { NotificationRelay } from "../src/lib/notify-relay.ts";

const base: Notification = {
  id: "01JBXY6Q8Z0000000000000001",
  kind: "approval",
  title: "Approval needed",
  body: "Send an email to jane.ortiz@example.com",
  taskId: null,
  approvalId: "01JBXY6Q8Z0000000000000002",
  route: null,
  actions: [{ id: "approve", label: "Approve" }],
  surfaces: ["desktop", "notification"],
  delivered: {},
  readAt: null,
  resolvedAt: null,
  createdAt: "2026-10-19T10:00:00.000Z",
};

describe("notification relay", () => {
  it("shows a fallback once, routed to the approval card, never with actions", () => {
    const r = new NotificationRelay();
    const d = r.decide(base);
    expect(d).toMatchObject({ show: true, route: "/agent/approvals", urgency: "critical" });
    expect(d).not.toHaveProperty("actions");
    expect(r.decide(base)).toMatchObject({ show: false, reason: "duplicate" });
  });

  it("defers to the mac helper and skips handled or in-app-only notifications", () => {
    const r = new NotificationRelay();
    r.helperOnline = true;
    expect(r.decide(base).reason).toBe("helper_delivers");
    r.helperOnline = false;
    expect(r.decide({ ...base, surfaces: ["desktop"] }).reason).toBe("not_os_surface");
    expect(r.decide({ ...base, resolvedAt: base.createdAt }).reason).toBe("already_handled");
    expect(r.decide({ ...base, delivered: { notification: base.createdAt } }).reason).toBe(
      "already_handled",
    );
  });

  it("only routes to known app paths", () => {
    const r = new NotificationRelay();
    expect(
      r.decide({ ...base, id: "a", approvalId: null, route: "/feed", kind: "briefing" }),
    ).toMatchObject({
      route: "/feed",
      urgency: "low",
    });
    expect(
      r.decide({ ...base, id: "b", approvalId: null, route: "https://evil.example" }).route,
    ).toBe("/inbox");
  });

  it("clicks open the notification's durable link: the chat card, a run, Scheduled → Runs", () => {
    const route = (kind: Notification["kind"], link: string | null, extra = {}) =>
      new NotificationRelay().decide({
        ...base,
        id: `n-${kind}-${link}`,
        kind,
        approvalId: null,
        route: link,
        ...extra,
      }).route;
    expect(route("approval", "/chat/th_1?approval=ap_1", { approvalId: "ap_1" })).toBe(
      "/chat/th_1?approval=ap_1",
    );
    expect(route("task_done", "/chat/th_1?message=m_9")).toBe("/chat/th_1?message=m_9");
    expect(route("task_failed", "/overview/run/run_7")).toBe("/overview/run/run_7");
    expect(route("task_failed", "/scheduled?tab=runs")).toBe("/scheduled?tab=runs");
    // An old or unknown link falls back to the inbox rather than a dead route.
    expect(route("task_done", "/tasks/t_1")).toBe("/inbox");
    expect(route("task_done", "/chat/th_1?message=<script>")).toBe("/inbox");
  });
});
