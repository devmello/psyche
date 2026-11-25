import { AgentToolRegistry } from "@psyche/agent-core";
import { appendMessage, createThread, getThread, openDb, setSetting } from "@psyche/db";
import type { ToolLookup } from "@psyche/proactive";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { composeNightShift } from "../src/compose/night-shift.ts";
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
        "INSERT INTO staged_actions (id, night_id, seq, domain, target_key, tool, kind, side_effect, params_hash, binding_hash, summary, why, taint, taint_sources, status, created_at, updated_at) VALUES ('s1', ?, 0, 'reminders', 'k', 't', 'connector_action', 'write', 'h', 'b', 'sum', 'From a Messages thread', 1, ?, 'ready', ?, ?)",
      )
      .run(
        night.id,
        JSON.stringify([{ sourceKind: "message", origin: "messages" }]),
        "2026-11-25T02:00:00Z",
        "2026-11-25T02:00:00Z",
      );
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
    expect(remote.items.find((i) => i.id === "s1")?.why).toBeNull();
    expect(desktop.items.find((i) => i.id === "s1")?.why).toBe("From a Messages thread");
  });
});
