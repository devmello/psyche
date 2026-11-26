import { openDb } from "@psyche/db";
import { type NotifierEvent, PsycheNotifier, SqliteNotificationStore } from "@psyche/notifications";
import {
  createPermissionBroker,
  type PolicyCall,
  type PsychePermissionBroker,
  SqlitePermissionStore,
} from "@psyche/permissions";
import { FakeClock, sha256 } from "@psyche/testing";
import { describe, expect, it } from "vitest";

/**
 * Item 11 of the approval QA: an approval that expires or is invalidated resolves its inbox
 * notification (`notification.resolved`), like an answered one, so a client no longer counts it
 * as needing the owner. The Gateway publishes every notifier "resolved" event as that WS event.
 */

const T0 = Date.parse("2026-11-26T10:00:00Z");
const NOTES = "/Users/owner/Notes/weekly.md";

function writeCall(): PolicyCall {
  const params = { path: NOTES, content: "notes" };
  return {
    tool: "write_file",
    sideEffect: "write",
    target: { kind: "path", value: NOTES },
    targetKind: "path",
    params,
    paramsHash: sha256(JSON.stringify(params)),
  };
}

function world() {
  const clock = new FakeClock(T0);
  const db = openDb(":memory:");
  const events: NotifierEvent[] = [];
  const notifier = new PsycheNotifier({
    store: new SqliteNotificationStore(db.sqlite),
    clock,
    delivery: "await",
  });
  notifier.subscribe((e) => events.push(e));
  const brokerOn = (): PsychePermissionBroker =>
    createPermissionBroker({
      armDelayMs: 0,
      clock,
      notifier,
      approvers: {
        device: async () => ({ scopes: ["operator.read", "operator.approvals"] }),
        isOwnerSender: async () => false,
      },
      store: new SqlitePermissionStore(db.sqlite),
      policy: { folders: [{ path: "/Users/owner", mode: "rw" }] },
    });
  async function raise(broker: PsychePermissionBroker) {
    const call = writeCall();
    const ctx = {
      threadId: "thr_1",
      runId: "run_1",
      permissionMode: "manual" as const,
      taint: false,
    };
    const d = await broker.decide(call, ctx);
    if (d.decision !== "ask" || d.approvalKind === undefined) throw new Error(`no ask: ${d.rule}`);
    return broker.requestApproval({
      kind: d.approvalKind,
      summary: "Write the notes",
      details: {},
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "k",
      requestedBy: { runId: "run_1", taskId: null, threadId: "thr_1" },
      sideEffect: "write",
      target: call.target,
      surfaces: ["desktop"],
      taint: false,
    });
  }
  const open = async () => (await notifier.list({ unresolvedOnly: true, kind: "approval" })) ?? [];
  const resolvedFor = (approvalId: string) =>
    events.filter((e) => e.type === "resolved" && e.notification.approvalId === approvalId).length;
  return { clock, db, brokerOn, raise, open, resolvedFor };
}

describe("an approval's notification is resolved when the approval ends", () => {
  it("a decided card resolves it (positive control)", async () => {
    const w = world();
    const broker = w.brokerOn();
    const { approval, answerTokens } = await w.raise(broker);
    expect(await w.open()).toHaveLength(1);
    await broker.answer({
      approvalId: approval.id,
      answerToken: answerTokens.desktop ?? "",
      decision: "deny",
      decidedBy: { deviceId: "dev_mac", surface: "desktop" },
    });
    expect(await w.open()).toHaveLength(0);
    expect(w.resolvedFor(approval.id)).toBe(1);
  });

  it("an expired card resolves it, and the event is emitted once", async () => {
    const w = world();
    const broker = w.brokerOn();
    const { approval } = await w.raise(broker);
    expect(await w.open()).toHaveLength(1);
    w.clock.advance(31 * 60_000);
    // The next read sweeps; the card's own timer does the same on a real clock.
    expect((await broker.get(approval.id))?.status).toBe("expired");
    await new Promise((r) => setTimeout(r, 0));
    expect(await w.open()).toHaveLength(0);
    expect(w.resolvedFor(approval.id)).toBe(1);
  });

  it("a card left over from the last boot is invalidated at restart and its notification resolves", async () => {
    const w = world();
    const first = w.brokerOn();
    const { approval } = await w.raise(first);
    expect(await w.open()).toHaveLength(1);
    // A new process: a new broker on the same database knows nothing of the first one's map.
    const second = w.brokerOn();
    await second.reissue({ stopRuns: new Set(["run_1"]) });
    expect((await second.get(approval.id))?.status).toBe("invalidated");
    await new Promise((r) => setTimeout(r, 0));
    expect(await w.open()).toHaveLength(0);
    expect(w.resolvedFor(approval.id)).toBe(1);
  });

  it("a card that is still pending keeps its notification (the fix does not resolve too much)", async () => {
    const w = world();
    const broker = w.brokerOn();
    const a = await w.raise(broker);
    w.clock.advance(60_000);
    await broker.list({ status: "pending" });
    expect(await w.open()).toHaveLength(1);
    expect(w.resolvedFor(a.approval.id)).toBe(0);
  });
});
