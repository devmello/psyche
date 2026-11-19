import type { ApprovalRequest } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  DeferredDigest,
  DIGEST_BODY,
  DIGEST_DEDUPE_KEY,
  DIGEST_ROUTE,
  digestTitle,
} from "../src/compose/deferred-digest.ts";

const HOUR = 60 * 60 * 1000;

/** The fields of a notification the digest reads or writes. */
interface Note {
  id: string;
  title: string;
  body: string;
  route?: string;
  dedupeKey?: string;
  approvalId?: string | null;
  resolvedAt: string | null;
}

function approval(id: string, taskId: string, extra: Partial<ApprovalRequest> = {}) {
  return {
    id,
    status: "pending",
    requestedBy: { runId: null, taskId, threadId: null },
    // Long-lived here: expiry has its own test, and the window test runs four hours on.
    expiresAt: new Date(Date.parse("2026-11-18T10:00:00Z") + 48 * HOUR).toISOString(),
    ...extra,
  } as unknown as ApprovalRequest;
}

function harness(initial: ApprovalRequest[]) {
  let now = Date.parse("2026-11-18T10:00:00Z");
  const state = { approvals: [...initial] };
  const notes: Note[] = [];
  let seq = 0;
  const notifier = {
    notes,
    async notify(input: { title: string; body: string; route?: string; dedupeKey?: string }) {
      const open = notes.find((n) => n.dedupeKey === input.dedupeKey && n.resolvedAt == null);
      if (open !== undefined) {
        open.title = input.title;
        return open;
      }
      const n: Note = { id: `n_${++seq}`, ...input, resolvedAt: null };
      notes.push(n);
      return n;
    },
    async resolve(id: string) {
      const n = notes.find((x) => x.id === id);
      if (n !== undefined) n.resolvedAt = "now";
      return n;
    },
    async list(filter: { unresolvedOnly?: boolean } = {}) {
      return notes.filter((n) => (filter.unresolvedOnly ? n.resolvedAt == null : true));
    },
  };
  const digest = new DeferredDigest({
    broker: { list: async () => state.approvals },
    notifier: notifier as never,
    isDeferred: (a) => a.requestedBy.taskId?.startsWith("auto_") === true,
    clock: { now: () => now },
  });
  return {
    digest,
    notifier,
    state,
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
    expect(h.notifier.notes).toHaveLength(1);
    expect(h.notifier.notes[0]).toMatchObject({
      title: digestTitle(3),
      body: DIGEST_BODY,
      route: DIGEST_ROUTE,
      dedupeKey: DIGEST_DEDUPE_KEY,
    });
    expect(digestTitle(3)).toBe("3 actions are waiting from your automations");
  });

  it("does not repeat within the window, and re-raises once the window has passed", async () => {
    const h = harness([approval("a1", "auto_1")]);
    await h.digest.refresh();
    h.state.approvals.push(approval("a2", "auto_2"));
    await h.digest.refresh();
    await h.digest.refresh();
    expect(h.notifier.notes).toHaveLength(1);
    h.advance(4 * HOUR);
    await h.digest.refresh();
    // The one open notice is refreshed in place, never a second card.
    expect(h.notifier.notes).toHaveLength(1);
    expect(h.notifier.notes[0]?.title).toBe(digestTitle(2));
  });

  it("ignores cards an owner is answering in chat (not unattended)", async () => {
    const h = harness([approval("o1", "chat_1")]);
    expect(await h.digest.refresh()).toBe(0);
    expect(h.notifier.notes).toHaveLength(0);
  });

  it("a card past its expiry is not counted, so it is never offered as waiting", async () => {
    const stale = approval("a1", "auto_1", { expiresAt: "2026-11-18T09:00:00.000Z" });
    const h = harness([stale]);
    expect(await h.digest.refresh()).toBe(0);
    expect(h.notifier.notes).toHaveLength(0);
  });

  it("resolves the digest once nothing is left waiting", async () => {
    const h = harness([approval("a1", "auto_1")]);
    await h.digest.refresh();
    h.state.approvals = [];
    expect(await h.digest.refresh()).toBe(0);
    expect(h.notifier.notes[0]?.resolvedAt).not.toBeNull();
  });
});
