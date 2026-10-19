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
});
