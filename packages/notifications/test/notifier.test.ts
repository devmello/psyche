import type { NotifierEvent, Question } from "@psyche/protocol";
import { FakeTaskEngine } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import type { NotificationStore, RoutingConfig } from "../src/index.ts";
import { setup as baseSetup, memoryStore, sqliteStore } from "./helpers.ts";

const MIN = 60_000;
const NIGHT = { start: "22:00", end: "07:00", timezone: "America/Los_Angeles" };
const quiet: RoutingConfig = { quietHours: NIGHT };

const STORES: [string, () => NotificationStore][] = [
  ["memory store", memoryStore],
  ["sqlite store", () => sqliteStore().store],
];

for (const [label, makeStore] of STORES) {
  describe(label, () => {
    const setup: typeof baseSetup = (options = {}) => baseSetup({ store: makeStore(), ...options });

    describe("de-duplication", () => {
      it("updates the open notification in place and does not re-deliver externally", async () => {
        const { notifier, os } = setup();
        const events: NotifierEvent["type"][] = [];
        notifier.subscribe((e) => events.push(e.type));
        const a = await notifier.notify({
          kind: "input_needed",
          title: "Q1",
          body: "?",
          taskId: "t1",
        });
        await notifier.markRead(a.id);
        const b = await notifier.notify({
          kind: "input_needed",
          title: "Q2",
          body: "?",
          taskId: "t1",
        });
        expect(b.id).toBe(a.id);
        expect(b.title).toBe("Q2");
        expect(b.readAt ?? null).toBeNull(); // unread again: there is something new
        expect(os.calls).toHaveLength(1);
        expect(events).toEqual(["created", "updated", "updated"]);
      });

      it("keys on kind and task, or on an explicit dedupeKey", async () => {
        const { notifier } = setup();
        await notifier.notify({ kind: "input_needed", title: "Q", body: "", taskId: "t1" });
        await notifier.notify({ kind: "input_needed", title: "Q", body: "", taskId: "t2" });
        await notifier.notify({
          kind: "proactive",
          title: "Idea",
          body: "",
          dedupeKey: "ideas:batch",
        });
        await notifier.notify({
          kind: "proactive",
          title: "Idea 2",
          body: "",
          dedupeKey: "ideas:batch",
        });
        await notifier.notify({ kind: "proactive", title: "No key", body: "" });
        await notifier.notify({ kind: "proactive", title: "No key", body: "" });
        expect(await notifier.list()).toHaveLength(5);
      });

      it("moves an updated notification to the top of the inbox", async () => {
        const { notifier } = setup();
        const a = await notifier.notify({
          kind: "input_needed",
          title: "A",
          body: "",
          taskId: "t1",
        });
        const b = await notifier.notify({ kind: "reminder", title: "B", body: "" });
        await notifier.notify({ kind: "input_needed", title: "A2", body: "", taskId: "t1" });
        expect((await notifier.list()).map((n) => n.id)).toEqual([a.id, b.id]);
      });

      it("a finished task resolves its open question and earlier failure", async () => {
        const { notifier } = setup();
        const q = await notifier.notify({
          kind: "input_needed",
          title: "Q",
          body: "",
          taskId: "t1",
        });
        const f = await notifier.notify({
          kind: "task_failed",
          title: "F",
          body: "",
          taskId: "t1",
        });
        expect((await notifier.get(q.id))?.resolvedAt).toBeTypeOf("string");
        const d = await notifier.notify({ kind: "task_done", title: "D", body: "", taskId: "t1" });
        expect((await notifier.get(f.id))?.resolvedAt).toBeTypeOf("string");
        expect((await notifier.list({ unresolvedOnly: true })).map((n) => n.id)).toEqual([d.id]);
      });
    });

    describe("delivery", () => {
      it("records delivery per surface and retries failures with backoff", async () => {
        const { notifier, os, clock } = setup({ retry: { maxAttempts: 3, baseDelayMs: MIN } });
        os.outcomes = [
          { status: "failed", error: "helper busy", retryable: true },
          { status: "failed", error: "helper busy", retryable: true },
        ];
        const n = await notifier.notify({ kind: "task_done", title: "Done", body: "" });
        expect(n.delivered.notification).toBeUndefined();
        expect(n.delivered.desktop).toBeTypeOf("string");
        expect(notifier.nextDueAt()).toBe(clock.now() + MIN);

        clock.advance(MIN);
        expect(await notifier.flushDue()).toBe(1);
        expect(notifier.nextDueAt()).toBe(clock.now() + 2 * MIN);
        clock.advance(2 * MIN);
        await notifier.flushDue();
        const deliveries = await notifier.deliveries(n.id);
        expect(deliveries.find((d) => d.surface === "notification")).toMatchObject({
          status: "delivered",
          attempts: 3,
        });
        expect((await notifier.get(n.id))?.delivered.notification).toBe(clock.iso());
        expect(os.calls.map((c) => c.attempt)).toEqual([1, 2, 3]);
      });

      it("gives up after maxAttempts and on non-retryable errors", async () => {
        const { notifier, os, chat, clock } = setup({
          retry: { maxAttempts: 2, baseDelayMs: MIN },
          routing: { channelTargets: ["telegram:42"] },
        });
        os.outcomes = [
          { status: "failed", error: "x", retryable: true },
          { status: "failed", error: "x", retryable: true },
        ];
        chat.outcomes = [{ status: "failed", error: "not_found", retryable: false }];
        const n = await notifier.notify({ kind: "task_done", title: "Done", body: "" });
        clock.advance(MIN);
        await notifier.flushDue();
        clock.advance(10 * MIN);
        expect(await notifier.flushDue()).toBe(0);
        const byStatus = Object.fromEntries(
          (await notifier.deliveries(n.id)).map((d) => [d.surface, d.status]),
        );
        expect(byStatus).toEqual({
          desktop: "delivered",
          web: "delivered",
          notification: "failed",
          "telegram:42": "failed",
        });
      });

      it("a surface with no adapter fails without retrying", async () => {
        const { notifier } = setup({ adapters: [] });
        const n = await notifier.notify({ kind: "task_done", title: "Done", body: "" });
        const os = (await notifier.deliveries(n.id)).find((d) => d.surface === "notification");
        expect(os).toMatchObject({
          status: "failed",
          detail: "no adapter for surface notification",
        });
      });

      it("an adapter that throws is retried", async () => {
        const { notifier } = setup({
          adapters: [
            {
              name: "boom",
              handles: () => true,
              deliver: () => Promise.reject(new Error("socket closed")),
            },
          ],
        });
        const n = await notifier.notify({ kind: "task_done", title: "Done", body: "" });
        const os = (await notifier.deliveries(n.id)).find((d) => d.surface === "notification");
        expect(os).toMatchObject({ status: "pending", detail: "socket closed", attempts: 1 });
      });
    });

    describe("quiet hours", () => {
      it("defers interruptive surfaces to the end of the window and keeps the inbox row", async () => {
        const { notifier, os, clock } = setup({ routing: quiet });
        clock.set(Date.UTC(2026, 9, 19, 6)); // 23:00 local
        const n = await notifier.notify({ kind: "task_done", title: "Done", body: "" });
        expect(os.calls).toHaveLength(0);
        expect(n.delivered.desktop).toBeTypeOf("string");
        expect(notifier.nextDueAt()).toBe(Date.UTC(2026, 9, 19, 14));

        clock.set(Date.UTC(2026, 9, 19, 13));
        expect(await notifier.flushDue()).toBe(0);
        clock.set(Date.UTC(2026, 9, 19, 14));
        expect(await notifier.flushDue()).toBe(1);
        expect(os.calls).toHaveLength(1);
      });

      it("delivers the latest content of a deduplicated notification after the window", async () => {
        const { notifier, os, clock } = setup({ routing: quiet });
        clock.set(Date.UTC(2026, 9, 19, 6));
        await notifier.notify({
          kind: "input_needed",
          title: "Which dates?",
          body: "",
          taskId: "t1",
        });
        await notifier.notify({
          kind: "input_needed",
          title: "Which hotel?",
          body: "",
          taskId: "t1",
        });
        clock.set(Date.UTC(2026, 9, 19, 14));
        await notifier.flushDue();
        expect(os.calls.map((c) => c.title)).toEqual(["Which hotel?"]);
      });

      it("drops deferred deliveries of notifications resolved in the meantime", async () => {
        const { notifier, os, clock } = setup({ routing: quiet });
        clock.set(Date.UTC(2026, 9, 19, 6));
        const n = await notifier.notify({ kind: "reminder", title: "Call", body: "" });
        await notifier.resolve(n.id);
        clock.set(Date.UTC(2026, 9, 19, 14));
        await notifier.flushDue();
        expect(os.calls).toHaveLength(0);
        expect(
          (await notifier.deliveries(n.id)).find((d) => d.surface === "notification")?.status,
        ).toBe("suppressed");
      });

      it("approvals break through", async () => {
        const { notifier, os, clock } = setup({ routing: quiet });
        clock.set(Date.UTC(2026, 9, 19, 6));
        await notifier.notify({
          kind: "approval",
          title: "Send email?",
          body: "",
          approvalId: "apr_1",
        });
        expect(os.calls).toHaveLength(1);
      });

      it("re-plans parked deliveries when the settings changed", async () => {
        let routing: RoutingConfig = quiet;
        const { notifier, os, clock } = setup({ routing: () => routing });
        clock.set(Date.UTC(2026, 9, 19, 6));
        await notifier.notify({ kind: "task_done", title: "Done", body: "" });
        // Owner extends quiet hours to 09:00 before the 07:00 flush.
        routing = { quietHours: { ...NIGHT, end: "09:00" } };
        clock.set(Date.UTC(2026, 9, 19, 14));
        expect(await notifier.flushDue()).toBe(0);
        expect(notifier.nextDueAt()).toBe(Date.UTC(2026, 9, 19, 16));
        expect(os.calls).toHaveLength(0);
      });
    });

    describe("restart reconciliation", () => {
      const QUESTION = {
        question: "Which dates?",
        header: "Dates",
        options: [{ label: "Nov 3" }, { label: "Nov 4" }],
        multiSelect: false,
      } as Question;

      it("marks approvals from before the restart stale (the Gateway invalidates them at boot)", async () => {
        const { notifier: before, restart } = setup();
        const a = await before.notify({
          kind: "approval",
          title: "Approve?",
          body: "",
          approvalId: "apr_1",
        });
        const r = await before.notify({ kind: "reminder", title: "Call", body: "" });
        const notifier = restart();
        const events: NotifierEvent[] = [];
        notifier.subscribe((e) => events.push(e));
        // S05 re-issues the approval as a new request before reconciliation runs.
        const reissued = await notifier.notify({
          kind: "approval",
          title: "Approve?",
          body: "",
          approvalId: "apr_2",
        });
        const res = await notifier.reconcile();
        expect((await notifier.get(reissued.id))?.resolvedAt ?? null).toBeNull();
        expect(res.stale.map((n) => n.id)).toEqual([a.id]);
        const after = await notifier.get(a.id);
        expect(after).toMatchObject({ staleReason: "approval invalidated by restart" });
        expect(after?.staleAt).toBeTypeOf("string");
        expect(after?.resolvedAt).toBeTypeOf("string");
        expect((await notifier.get(r.id))?.resolvedAt ?? null).toBeNull();
        expect(events.at(-1)).toMatchObject({ type: "resolved", notification: { id: a.id } });
      });

      it("checks task-bound notifications against the task engine", async () => {
        const tasks = new FakeTaskEngine();
        const t = await tasks.create({
          threadId: "th1",
          title: "T",
          goal: "g",
          createdFrom: "chat",
        });
        const ireq = await tasks.requestInput(t.id, [QUESTION]);
        const { notifier } = setup();
        const q = await notifier.notify({
          kind: "input_needed",
          title: "Q",
          body: "",
          taskId: t.id,
        });
        const gone = await notifier.notify({
          kind: "task_done",
          title: "D",
          body: "",
          taskId: "task_missing",
        });
        let res = await notifier.reconcile({ tasks });
        expect(res.stale.map((n) => n.id)).toEqual([gone.id]);

        await tasks.answerInput(ireq.id, { Dates: "Nov 3" });
        res = await notifier.reconcile({ tasks });
        expect(res.stale.map((n) => n.id)).toEqual([q.id]);
        expect((await notifier.get(q.id))?.staleReason).toBe("task is no longer waiting for input");
      });

      it("re-queues deliveries cut off mid-flight and drops those of stale notifications", async () => {
        const { notifier: before, store, clock, restart } = setup({ routing: quiet });
        clock.set(Date.UTC(2026, 9, 19, 6));
        const done = await before.notify({ kind: "task_done", title: "D", body: "" });
        const a = await before.notify({
          kind: "approval",
          title: "A",
          body: "",
          approvalId: "apr_1",
        });
        const r = await before.notify({
          kind: "reminder",
          title: "R",
          body: "",
          surfaces: ["notification"],
        });
        // Simulate crashes during the OS deliveries: the rows still say pending, with no dueAt.
        for (const id of [a.id, r.id]) {
          const d = store.deliveries(id).find((x) => x.surface === "notification");
          if (d !== undefined) store.upsertDelivery({ ...d, status: "pending", dueAt: null });
        }
        const notifier = restart();
        const res = await notifier.reconcile();
        expect(res.requeued).toBe(1);
        expect(
          (await notifier.deliveries(r.id)).find((d) => d.surface === "notification")?.dueAt,
        ).toBe(clock.iso());
        expect(res.stale.map((n) => n.id)).toEqual([a.id]);
        expect(
          (await notifier.deliveries(a.id)).find((d) => d.surface === "notification")?.status,
        ).toBe("suppressed");
        expect(
          (await notifier.deliveries(done.id)).find((d) => d.surface === "notification")?.status,
        ).toBe("deferred");
      });

      it("applies custom staleness rules", async () => {
        const { notifier } = setup();
        const b = await notifier.notify({ kind: "briefing", title: "Brief", body: "" });
        const res = await notifier.reconcile({
          isStale: (n) => (n.kind === "briefing" ? "superseded by today's brief" : undefined),
        });
        expect(res.stale).toHaveLength(1);
        expect((await notifier.get(b.id))?.staleReason).toBe("superseded by today's brief");
      });
    });

    describe("actions", () => {
      it("runs a notification action, then resolves", async () => {
        const seen: string[] = [];
        const { notifier } = setup({ onAction: (n, id) => void seen.push(`${n.kind}:${id}`) });
        const n = await notifier.notify({
          kind: "task_failed",
          title: "Failed",
          body: "",
          taskId: "t1",
          actions: [{ id: "retry", label: "Retry" }],
        });
        const r = await notifier.resolveWithAction(n.id, "retry");
        expect(seen).toEqual(["task_failed:retry"]);
        expect(r.resolvedAt).toBeTypeOf("string");
        // Already resolved: the action does not run twice.
        await notifier.resolveWithAction(n.id, "retry");
        expect(seen).toHaveLength(1);
      });

      it("refuses approval answers and unknown actions", async () => {
        const { notifier } = setup();
        const a = await notifier.notify({
          kind: "approval",
          title: "A",
          body: "",
          approvalId: "apr_1",
          actions: [
            { id: "approve", label: "Approve" },
            { id: "deny", label: "Deny", destructive: true },
          ],
        });
        await expect(notifier.resolveWithAction(a.id, "approve")).rejects.toMatchObject({
          code: "invalid_params",
        });
        await expect(notifier.resolveWithAction(a.id, "snooze")).rejects.toMatchObject({
          code: "invalid_params",
        });
        await expect(notifier.resolveWithAction("ntf_x", "snooze")).rejects.toMatchObject({
          code: "not_found",
        });
      });

      it("emits read and resolve events only on change", async () => {
        const { notifier } = setup();
        const events: string[] = [];
        notifier.subscribe((e) => events.push(e.type));
        const n = await notifier.notify({ kind: "system", title: "Hi", body: "" });
        await notifier.markRead(n.id);
        await notifier.markRead(n.id);
        await notifier.resolve(n.id);
        await notifier.resolve(n.id);
        expect(events).toEqual(["created", "updated", "resolved"]);
      });

      it("a throwing listener does not break the others", async () => {
        const { notifier } = setup();
        const seen: string[] = [];
        notifier.subscribe(() => {
          throw new Error("bad listener");
        });
        notifier.subscribe((e) => seen.push(e.type));
        await notifier.notify({ kind: "system", title: "Hi", body: "" });
        expect(seen).toEqual(["created"]);
      });
    });

    describe("concurrency and edge cases", () => {
      it("two approvals on one task are two notifications", async () => {
        const { notifier } = setup();
        const a = await notifier.notify({
          kind: "approval",
          title: "A",
          body: "",
          taskId: "t1",
          approvalId: "apr_1",
        });
        const b = await notifier.notify({
          kind: "approval",
          title: "B",
          body: "",
          taskId: "t1",
          approvalId: "apr_2",
        });
        expect(b.id).not.toBe(a.id);
        expect(b.approvalId).toBe("apr_2");
        // The same approval re-notified updates its own row.
        const a2 = await notifier.notify({
          kind: "approval",
          title: "A2",
          body: "",
          taskId: "t1",
          approvalId: "apr_1",
        });
        expect(a2.id).toBe(a.id);
      });

      it("a repeated terminal notification still closes a newer question", async () => {
        const { notifier } = setup();
        await notifier.notify({ kind: "task_failed", title: "F1", body: "", taskId: "t1" });
        const q = await notifier.notify({
          kind: "input_needed",
          title: "Q",
          body: "",
          taskId: "t1",
        });
        const f2 = await notifier.notify({
          kind: "task_failed",
          title: "F2",
          body: "",
          taskId: "t1",
        });
        expect((await notifier.get(q.id))?.resolvedAt).toBeTypeOf("string");
        expect((await notifier.get(f2.id))?.resolvedAt ?? null).toBeNull();
      });

      it("overlapping flushes deliver once", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
          release = r;
        });
        const calls: string[] = [];
        const slow = {
          name: "slow",
          handles: () => true,
          deliver: async (n: { id: string }) => {
            calls.push(n.id);
            await gate;
            return { status: "delivered" as const };
          },
        };
        const { notifier, clock } = setup({ routing: quiet, adapters: [slow] });
        clock.set(Date.UTC(2026, 9, 19, 6));
        await notifier.notify({ kind: "task_done", title: "D", body: "" });
        clock.set(Date.UTC(2026, 9, 19, 14));
        const first = notifier.flushDue();
        await Promise.resolve();
        expect(notifier.nextDueAt()).toBeUndefined();
        const second = await notifier.flushDue();
        release();
        await first;
        expect(second).toBe(0);
        expect(calls).toHaveLength(1);
      });

      it("runs an action once when two clients press it", async () => {
        let runs = 0;
        const { notifier } = setup({
          onAction: async () => {
            runs += 1;
            await Promise.resolve();
          },
        });
        const n = await notifier.notify({
          kind: "task_failed",
          title: "F",
          body: "",
          actions: [{ id: "retry", label: "Retry" }],
        });
        await Promise.all([
          notifier.resolveWithAction(n.id, "retry"),
          notifier.resolveWithAction(n.id, "retry"),
        ]);
        expect(runs).toBe(1);
      });

      it("a failing action leaves the notification open", async () => {
        const { notifier } = setup({
          onAction: () => {
            throw new Error("task engine down");
          },
        });
        const n = await notifier.notify({
          kind: "task_failed",
          title: "F",
          body: "",
          actions: [{ id: "retry", label: "Retry" }],
        });
        await expect(notifier.resolveWithAction(n.id, "retry")).rejects.toThrow("task engine down");
        expect((await notifier.get(n.id))?.resolvedAt ?? null).toBeNull();
      });

      it("refuses every answering action on approvals, allows open", async () => {
        const opened: string[] = [];
        const { notifier } = setup({ onAction: (_n, id) => void opened.push(id) });
        const a = await notifier.notify({
          kind: "approval",
          title: "A",
          body: "",
          approvalId: "apr_1",
          actions: [
            { id: "approve_always", label: "Always" },
            { id: "open", label: "Open" },
          ],
        });
        await expect(notifier.resolveWithAction(a.id, "approve_always")).rejects.toMatchObject({
          code: "invalid_params",
        });
        await notifier.resolveWithAction(a.id, "open");
        expect(opened).toEqual(["open"]);
      });

      it("a resolve during a failing delivery is not revived for retry", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
          release = r;
        });
        const flaky = {
          name: "flaky",
          handles: () => true,
          deliver: async () => {
            await gate;
            return { status: "failed" as const, error: "busy", retryable: true };
          },
        };
        const { notifier } = setup({ adapters: [flaky], delivery: "background" });
        const n = await notifier.notify({ kind: "task_done", title: "D", body: "" });
        await notifier.resolve(n.id);
        release();
        await notifier.settled();
        const os = (await notifier.deliveries(n.id)).find((d) => d.surface === "notification");
        expect(os?.status).toBe("suppressed");
        expect(notifier.nextDueAt()).toBeUndefined();
      });

      it("background delivery: notify returns before a slow helper answers", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
          release = r;
        });
        const slow = {
          name: "slow",
          handles: () => true,
          deliver: async () => {
            await gate;
            return { status: "delivered" as const };
          },
        };
        const { notifier } = setup({ adapters: [slow], delivery: "background" });
        const n = await notifier.notify({ kind: "task_done", title: "D", body: "" });
        expect(n.delivered.notification).toBeUndefined();
        release();
        await notifier.settled();
        expect((await notifier.get(n.id))?.delivered.notification).toBeTypeOf("string");
      });
    });
  });
}
