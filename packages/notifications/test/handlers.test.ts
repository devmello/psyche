import { createValidator, type MethodName, Methods, validateEventPayload } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { createNotificationHandlers, toGatewayEvent } from "../src/index.ts";
import { setup } from "./helpers.ts";

function checkResult(method: MethodName, result: unknown): void {
  expect(createValidator(Methods[method].result).errors(result)).toEqual([]);
}

describe("notifications.* handlers", () => {
  it("pages newest first with an opaque cursor", async () => {
    const { notifier } = setup();
    const h = createNotificationHandlers(notifier);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1)
      ids.push((await notifier.notify({ kind: "system", title: `n${i}`, body: "" })).id);
    const p1 = await h["notifications.list"]({ limit: 2 });
    checkResult("notifications.list", p1);
    expect(p1.notifications.map((n) => n.id)).toEqual([ids[4], ids[3]]);
    const p2 = await h["notifications.list"]({ limit: 2, cursor: p1.nextCursor ?? undefined });
    const p3 = await h["notifications.list"]({ limit: 2, cursor: p2.nextCursor ?? undefined });
    expect([...p2.notifications, ...p3.notifications].map((n) => n.id)).toEqual([
      ids[2],
      ids[1],
      ids[0],
    ]);
    expect(p3.nextCursor).toBeNull();
    await expect(h["notifications.list"]({ cursor: "garbage" })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("marks read in bulk, counting only changes, and rejects unknown ids", async () => {
    const { notifier } = setup();
    const h = createNotificationHandlers(notifier);
    const a = await notifier.notify({ kind: "system", title: "a", body: "" });
    const b = await notifier.notify({ kind: "system", title: "b", body: "" });
    await notifier.markRead(a.id);
    const res = await h["notifications.markRead"]({ notificationIds: [a.id, b.id, b.id] });
    checkResult("notifications.markRead", res);
    expect(res).toEqual({ updated: 1 });
    await expect(
      h["notifications.markRead"]({ notificationIds: [a.id, "ntf_missing"] }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await h["notifications.list"]({ unreadOnly: true })).notifications).toEqual([]);
  });

  it("resolves, with or without an action", async () => {
    const { notifier } = setup();
    const h = createNotificationHandlers(notifier);
    const n = await notifier.notify({
      kind: "reminder",
      title: "Call",
      body: "",
      actions: [{ id: "done", label: "Done" }],
    });
    const res = await h["notifications.resolve"]({ notificationId: n.id, actionId: "done" });
    checkResult("notifications.resolve", res);
    expect(res.notification.resolvedAt).toBeTypeOf("string");
  });

  it("maps notifier events to valid WS events", async () => {
    const { notifier } = setup();
    const events: ReturnType<typeof toGatewayEvent>[] = [];
    notifier.subscribe((e) => events.push(toGatewayEvent(e)));
    const n = await notifier.notify({ kind: "system", title: "a", body: "" });
    await notifier.markRead(n.id);
    await notifier.resolve(n.id);
    expect(events.map((e) => e.event)).toEqual([
      "notification.created",
      "notification.updated",
      "notification.resolved",
    ]);
    for (const e of events) expect(() => validateEventPayload(e.event, e.payload)).not.toThrow();
  });
});
