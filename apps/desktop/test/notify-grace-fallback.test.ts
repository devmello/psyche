import type { Notification } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELPER_GRACE_MS, NotificationRelay } from "../src/lib/notify-relay.ts";

const base: Notification = {
  id: "01JBXY6Q8Z0000000000000019",
  kind: "approval",
  title: "Approval needed",
  body: "Send an email",
  taskId: null,
  approvalId: "01JBXY6Q8Z0000000000000020",
  route: null,
  actions: [],
  surfaces: ["desktop", "notification"],
  delivered: {},
  readAt: null,
  resolvedAt: null,
  createdAt: "2026-11-24T10:00:00.000Z",
};

async function run(latest: Notification | undefined) {
  const r = new NotificationRelay();
  r.setPresence(true);
  const shown: string[] = [];
  expect(r.decide(base).reason).toBe("helper_delivers");
  r.graceFallback(
    base,
    async () => latest,
    (d) => d.show && shown.push(d.title ?? ""),
  );
  await vi.advanceTimersByTimeAsync(HELPER_GRACE_MS + 10);
  return shown;
}

describe("helper online but the delivery fails", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("falls back to the Electron toast once", async () => {
    expect(await run(base)).toEqual(["Approval needed"]);
  });

  it("shows nothing when the helper recorded the delivery (no double banner)", async () => {
    const shown = await run({ ...base, delivered: { notification: "2026-11-24T10:00:01.000Z" } });
    expect(shown).toEqual([]);
  });

  it("shows nothing when the notification was read or gone meanwhile", async () => {
    expect(await run({ ...base, readAt: "2026-11-24T10:00:02.000Z" })).toEqual([]);
    expect(await run(undefined)).toEqual([]);
  });

  it("does not show a second toast for the same id", async () => {
    const r = new NotificationRelay();
    r.setPresence(true);
    const shown: string[] = [];
    for (let i = 0; i < 2; i++)
      r.graceFallback(
        base,
        async () => base,
        (d) => d.show && shown.push("x"),
      );
    await vi.advanceTimersByTimeAsync(HELPER_GRACE_MS + 10);
    expect(shown).toHaveLength(1);
  });
});
