import type { Notifier, NotifierEvent } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { type ConformanceFactory, expectPsycheError, newContext } from "./harness.ts";

/** Architecture §4.12: durable inbox, read / resolve, de-duplication, subscriptions. */
export function describeNotifierConformance(
  name: string,
  factory: ConformanceFactory<Notifier>,
): void {
  const setup = () => factory(newContext());

  describe(`Notifier conformance: ${name}`, () => {
    it("creates, lists newest first, marks read and resolves", async () => {
      const n = await setup();
      const a = await n.notify({
        kind: "task_done",
        title: "Done",
        body: "Booked",
        route: "/tasks/1",
      });
      const b = await n.notify({ kind: "reminder", title: "Call mom", body: "at 6" });
      expect((await n.list()).map((x) => x.id)).toEqual([b.id, a.id]);
      expect(a.readAt ?? null).toBeNull();
      expect((await n.markRead(a.id)).readAt).toBeTypeOf("string");
      expect((await n.list({ unreadOnly: true })).map((x) => x.id)).toEqual([b.id]);
      expect((await n.resolve(b.id)).resolvedAt).toBeTypeOf("string");
      expect((await n.list({ unresolvedOnly: true })).map((x) => x.id)).toEqual([a.id]);
      expect(a.route).toBe("/tasks/1");
    });

    it("de-duplicates per task and kind while unresolved", async () => {
      const n = await setup();
      const first = await n.notify({
        kind: "input_needed",
        title: "Q1",
        body: "?",
        taskId: "task_1",
      });
      const second = await n.notify({
        kind: "input_needed",
        title: "Q2",
        body: "??",
        taskId: "task_1",
      });
      expect(second.id).toBe(first.id);
      expect(second.title).toBe("Q2");
      expect(await n.list()).toHaveLength(1);
      await n.resolve(first.id);
      const third = await n.notify({
        kind: "input_needed",
        title: "Q3",
        body: "?",
        taskId: "task_1",
      });
      expect(third.id).not.toBe(first.id);
    });

    it("notifies subscribers until they unsubscribe", async () => {
      const n = await setup();
      const seen: NotifierEvent["type"][] = [];
      const off = n.subscribe((e) => seen.push(e.type));
      const x = await n.notify({ kind: "proactive", title: "Idea", body: "…" });
      await n.resolve(x.id);
      off();
      await n.notify({ kind: "proactive", title: "Another", body: "…" });
      expect(seen).toEqual(["created", "resolved"]);
    });

    it("unknown ids are not_found", async () => {
      const n = await setup();
      await expectPsycheError(n.markRead("ntf_missing"), "not_found");
      await expectPsycheError(n.resolve("ntf_missing"), "not_found");
    });
  });
}
