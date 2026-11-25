import { AgentToolRegistry } from "@psyche/agent-core";
import { appendMessage, createThread, getThread, openDb, setSetting } from "@psyche/db";
import type { ToolLookup } from "@psyche/proactive";
import type { StagedAction } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  composeNightShift,
  forRemote,
  MESSAGES_ITEM_LINE,
  personalizeNightShiftItem,
} from "../src/compose/night-shift.ts";
import { connectorToolLookup } from "../src/compose/proactive.ts";
import type { Call } from "../src/context.ts";

const START = Date.parse("2026-11-25T01:00:00Z");
const GOOD = {
  onAc: true,
  batteryPct: 100,
  lowPowerMode: false,
  thermal: "nominal" as const,
  idleMinutes: 60,
};

function rig(calendarEvents: Record<string, unknown[]> = {}) {
  const clock = new FakeClock(START);
  const db = openDb(":memory:", { now: () => new Date(clock.now()).toISOString() });
  setSetting(db, "nightShift.enabled", true);
  const main = createThread(db, { kind: "main", sessionKey: "main" });
  appendMessage(
    db,
    {
      threadId: main.id,
      role: "user",
      blocks: [{ type: "text", md: "my bank PIN is 4321" }],
      provenance: "owner",
      runId: null,
    },
    { expectedWriterRunId: null },
  );
  const registry = new AgentToolRegistry();
  const called: string[] = [];
  for (const [id, events] of Object.entries(calendarEvents)) {
    registry.register({
      spec: {
        name: `mcp__${id}__calendar_list_events`,
        description: "events",
        inputSchema: { type: "object" },
        sideEffect: "read",
        provenanceOut: "trusted",
      },
      execute: async () => {
        called.push(id);
        return { output: events, provenance: "trusted" };
      },
    } as never);
  }
  const created: { threadId: string; title: string; goal: string }[] = [];
  const ns = composeNightShift({
    db,
    clock,
    scheduler: {
      list: async () => [],
      get: async () => undefined,
      create: async () => ({}) as never,
      update: async () => ({}) as never,
      remove: async () => {},
    },
    notifier: { notify: async () => ({}) as never },
    tasks: {
      create: async (i: { threadId: string; title: string; goal: string }) => {
        created.push(i);
        return { id: `task_${created.length}` } as never;
      },
      get: async () => ({ id: "t", status: "done" }) as never,
      cancel: async () => undefined,
      subscribe: () => () => undefined,
    },
    poke: () => undefined,
    registry,
    lookup: () => connectorToolLookup(registry) as ToolLookup,
    keepAwake: { acquire: () => () => undefined },
    readState: async () => GOOD,
    timeZone: () => "UTC",
    connectors: async () => [
      // A custom connector registered first, then the real one.
      { id: "custom", type: "custom" },
      { id: "apple", type: "apple" },
    ],
    folders: () => [],
    mailCandidates: async () => [],
    followups: { list: () => [] } as never,
  });
  return { ns, db, main, created, called, clock };
}

const overlapping = [
  {
    id: "e1",
    title: "Focus",
    start: "2026-11-25T09:00:00Z",
    end: "2026-11-25T10:00:00Z",
    attendees: [],
  },
  {
    id: "e2",
    title: "Gym",
    start: "2026-11-25T09:30:00Z",
    end: "2026-11-25T10:30:00Z",
    attendees: [],
  },
];

describe("Night shift in the Gateway", () => {
  it("jobs run in their own thread and never see the main chat (control: main has the message)", async () => {
    const r = rig({ apple: overlapping });
    await r.ns.start();
    await r.ns.service.run();
    expect(r.created).toHaveLength(1);
    const thread = getThread(r.db, r.created[0]?.threadId as string);
    expect(thread?.id).not.toBe(r.main.id);
    expect(thread?.kind).toBe("automation");
    const keyed = r.db.sqlite
      .prepare("SELECT session_key AS k FROM threads WHERE id = ?")
      .get(thread?.id) as { k: string };
    expect(keyed.k).toMatch(/^night-shift:/);
    const count = (id: string) =>
      (
        r.db.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE thread_id = ?").get(id) as {
          n: number;
        }
      ).n;
    expect(count(r.main.id)).toBe(1);
    expect(count(thread?.id as string)).toBe(0);
  });

  it("calendar reads go to the stageable connector by id, not to a custom one registered first", async () => {
    const r = rig({ custom: overlapping, apple: overlapping });
    await r.ns.start();
    await r.ns.service.run();
    expect(r.called).toContain("apple");
    expect(r.called).not.toContain("custom");
  });

  it("review.get gives no candidate list, and clears an owner-only why for a remote caller", async () => {
    const r = rig({ apple: overlapping });
    await r.ns.start();
    const out = await r.ns.service.run();
    const night = out.night;
    if (night === undefined) throw new Error("no night");
    // An item whose why came from an owner-only source (Messages).
    const store = { insertStagedAction: (i: never) => i as never };
    void store;
    r.db.sqlite
      .prepare(
        "INSERT INTO staged_actions (id, night_id, seq, domain, target_key, tool, kind, side_effect, params_hash, binding_hash, summary, why, taint, taint_sources, status, created_at, updated_at) VALUES ('s1', ?, 0, 'reminders', 'k', 't', 'connector_action', 'write', 'h', 'b', 'Pay the invoice', 'From a Messages thread', 1, ?, 'ready', ?, ?)",
      )
      .run(
        night.id,
        JSON.stringify([{ sourceKind: "message", origin: "messages" }]),
        "2026-11-25T02:00:00Z",
        "2026-11-25T02:00:00Z",
      );
    r.db.sqlite
      .prepare("UPDATE staged_actions SET params = ? WHERE id = 's1'")
      .run(JSON.stringify({ title: "Pay the invoice" }));
    r.db.sqlite
      .prepare(
        "INSERT INTO staged_actions (id, night_id, seq, domain, target_key, tool, kind, side_effect, params_hash, binding_hash, summary, why, taint, taint_sources, status, created_at, updated_at) VALUES ('s2', ?, 1, 'reminders', 'k2', 't', 'connector_action', 'write', 'h', 'b', 'Water the plants', 'You asked', 0, '[]', 'ready', ?, ?)",
      )
      .run(night.id, "2026-11-25T02:00:00Z", "2026-11-25T02:00:00Z");
    r.db.sqlite
      .prepare("UPDATE night_shift_nights SET review_status = 'ready' WHERE id = ?")
      .run(night.id);
    const call = (desktop: boolean) =>
      ({
        identity: { desktopShell: desktop },
        conn: { peer: { remoteLoopback: desktop } },
      }) as unknown as Call;
    const get = (desktop: boolean) =>
      r.ns.reviewGet(call(desktop), { reviewId: night.id } as never);
    const remote = await get(false);
    const desktop = await get(true);
    expect(remote.night.candidates).toBeNull();
    expect(desktop.night.candidates).toBeNull();
    const r1 = remote.items.find((i) => i.id === "s1");
    const d1 = desktop.items.find((i) => i.id === "s1");
    // A remote device gets the kind, domain and status, and a generic line: nothing of the item.
    expect(r1).toMatchObject({
      domain: "reminders",
      status: "ready",
      why: null,
      params: null,
      summary: MESSAGES_ITEM_LINE,
      preview: { kind: "reminder", title: MESSAGES_ITEM_LINE, rows: [] },
    });
    expect(JSON.stringify(r1)).not.toContain("Pay the invoice");
    // The desktop shell sees all of it (positive control).
    expect(d1).toMatchObject({
      why: "From a Messages thread",
      summary: "Pay the invoice",
      params: { title: "Pay the invoice" },
    });
    // An item with no Messages taint is the same for both callers.
    expect(remote.items.find((i) => i.id === "s2")).toEqual(
      desktop.items.find((i) => i.id === "s2"),
    );
  });
});

describe("Night shift items for remote readers (W5)", () => {
  const SECRET = "Pick up Mia from the dentist at 4";
  const item = (sourceKind: "message" | "email") =>
    ({
      id: "s1",
      nightId: "n1",
      seq: 0,
      domain: "reminders",
      targetKey: "k",
      tool: "reminders_create",
      summary: SECRET,
      why: "From a thread",
      params: { title: SECRET },
      status: "failed",
      taint: true,
      taintSources: [{ sourceKind, origin: "x" }],
      result: { refs: ["rem_1"], receiptId: "rcpt_1", error: `Reminders refused "${SECRET}"` },
    }) as unknown as StagedAction;

  it("forRemote clears an item from Messages' result error and keeps its refs and receipt", () => {
    const out = forRemote(item("message"));
    expect(out.result).toEqual({ refs: ["rem_1"], receiptId: "rcpt_1" });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("nightShift.item.updated: the full item only for the desktop shell on this Mac", () => {
    const payload = { item: item("message") };
    // The local desktop shell: the shared frame as published.
    expect(personalizeNightShiftItem(payload, { local: true })).toBeUndefined();
    // A paired phone, the web, a remote desktop shell, a Gateway part with no reader.
    for (const reader of [{ local: false }, {}]) {
      const out = personalizeNightShiftItem(payload, reader);
      expect(out?.item).toMatchObject({ withheld: "messages", summary: MESSAGES_ITEM_LINE });
      expect(JSON.stringify(out)).not.toContain(SECRET);
    }
    // Control: an item with no Messages taint is the same for everyone.
    expect(personalizeNightShiftItem({ item: item("email") }, { local: false })).toBeUndefined();
  });
});
