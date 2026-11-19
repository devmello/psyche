import { PsycheNotifier } from "@psyche/notifications";
import type { ApprovalRequest } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  DeferredDigest,
  DIGEST_BODY,
  DIGEST_BODY_KEY,
  DIGEST_DEDUPE_KEY,
  DIGEST_ROUTE,
  DIGEST_TITLE_KEY,
  digestTitle,
} from "../src/compose/deferred-digest.ts";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-11-18T10:00:00Z");

function approval(id: string, taskId: string, extra: Partial<ApprovalRequest> = {}) {
  return {
    id,
    status: "pending",
    requestedBy: { runId: null, taskId, threadId: null },
    // Long-lived here: expiry has its own test, and the window test runs four hours on.
    expiresAt: new Date(T0 + 48 * HOUR).toISOString(),
    ...extra,
  } as unknown as ApprovalRequest;
}

/** The real notifier (dedupe, in-place updates, resolve) with every alert and update counted. */
function harness(initial: ApprovalRequest[]) {
  let now = T0;
  const clock = { now: () => now };
  const state = { approvals: [...initial] };
  const notifier = new PsycheNotifier({ clock });
  const events: { type: string; id: string; title: string }[] = [];
  notifier.subscribe((e) =>
    events.push({ type: e.type, id: e.notification.id, title: e.notification.title }),
  );
  const listed: unknown[] = [];
  const digest = new DeferredDigest({
    broker: {
      list: async (filter) => {
        listed.push(filter);
        return state.approvals.filter(
          (a) => filter?.status === undefined || a.status === filter.status,
        );
      },
    },
    notifier,
    isDeferred: (a) => a.requestedBy.taskId?.startsWith("auto_") === true,
    clock,
  });
  const open = async () =>
    (await notifier.list({ unresolvedOnly: true })).filter((n) => n.route === DIGEST_ROUTE);
  const alerts = () => events.filter((e) => e.type === "created").length;
  return {
    digest,
    notifier,
    state,
    open,
    alerts,
    events,
    listed,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("automation digest (Deferred)", () => {
  it("raises one digest for many deferred actions, not one card each", async () => {
    const h = harness([
      approval("a1", "auto_1"),
      approval("a2", "auto_2"),
      approval("a3", "auto_3"),
    ]);
    expect(await h.digest.refresh()).toBe(3);
    const open = await h.open();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      title: digestTitle(3),
      body: DIGEST_BODY,
      route: DIGEST_ROUTE,
      message: { titleKey: DIGEST_TITLE_KEY, bodyKey: DIGEST_BODY_KEY, params: { count: 3 } },
    });
    expect(digestTitle(3)).toBe("3 actions are waiting from your automations");
    expect(h.alerts()).toBe(1);
  });

  it("lists only pending approvals from the broker", async () => {
    const h = harness([approval("a1", "auto_1")]);
    await h.digest.refresh();
    expect(h.listed).toEqual([{ status: "pending" }]);
  });

  it("while open, updates its count in place without a second alert", async () => {
    const h = harness([approval("a1", "auto_1")]);
    await h.digest.refresh();
    h.state.approvals.push(approval("a2", "auto_2"));
    await h.digest.refresh();
    await h.digest.refresh();
    const open = await h.open();
    expect(open).toHaveLength(1);
    expect(open[0]?.title).toBe(digestTitle(2));
    expect(open[0]?.message?.params).toEqual({ count: 2 });
    expect(h.alerts()).toBe(1);
    expect(h.events.some((e) => e.type === "updated")).toBe(true);
  });

  it("B4: after a dismissal, a new card raises the digest again at once", async () => {
    const h = harness([approval("a1", "auto_1")]);
    await h.digest.refresh();
    const first = (await h.open())[0];
    await h.notifier.resolve(first?.id ?? "");
    expect(await h.open()).toHaveLength(0);
    h.advance(10 * 60_000);
    h.state.approvals.push(approval("a2", "auto_2"));
    expect(await h.digest.refresh()).toBe(2);
    const open = await h.open();
    expect(open).toHaveLength(1);
    expect(open[0]?.id).not.toBe(first?.id);
    expect(open[0]?.title).toBe(digestTitle(2));
    expect(h.alerts()).toBe(2);
  });

  it("after a dismissal with nothing new, stays quiet until the window passes", async () => {
    const h = harness([approval("a1", "auto_1")]);
    await h.digest.refresh();
    await h.notifier.resolve((await h.open())[0]?.id ?? "");
    await h.digest.refresh();
    expect(await h.open()).toHaveLength(0);
    h.advance(4 * HOUR);
    await h.digest.refresh();
    expect(await h.open()).toHaveLength(1);
    expect(h.alerts()).toBe(2);
  });

  it("ignores cards an owner is answering in chat (not unattended)", async () => {
    const h = harness([approval("o1", "chat_1")]);
    expect(await h.digest.refresh()).toBe(0);
    expect(await h.open()).toHaveLength(0);
  });

  it("a card past its expiry is not counted, so it is never offered as waiting", async () => {
    const stale = approval("a1", "auto_1", { expiresAt: "2026-11-18T09:00:00.000Z" });
    const h = harness([stale]);
    expect(await h.digest.refresh()).toBe(0);
    expect(await h.open()).toHaveLength(0);
  });

  it("resolves the digest once nothing is left waiting", async () => {
    const h = harness([approval("a1", "auto_1")]);
    await h.digest.refresh();
    h.state.approvals = [];
    expect(await h.digest.refresh()).toBe(0);
    expect(await h.open()).toHaveLength(0);
  });

  it("finds and closes a digest left open by an earlier process", async () => {
    const h = harness([]);
    await h.notifier.notify({
      kind: "approval",
      title: digestTitle(1),
      body: DIGEST_BODY,
      message: { titleKey: DIGEST_TITLE_KEY, bodyKey: DIGEST_BODY_KEY, params: { count: 1 } },
      route: DIGEST_ROUTE,
      dedupeKey: DIGEST_DEDUPE_KEY,
    });
    expect(await h.digest.refresh()).toBe(0);
    expect(await h.open()).toHaveLength(0);
  });
});
