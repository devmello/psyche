import { type AgentToolRegistration, defineTool } from "@psyche/agent-core";
import { createPermissionBroker } from "@psyche/permissions";
import { FakeClock } from "@psyche/testing";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  type Draft,
  type DraftService,
  FOCUS_EVENT_TITLE,
  FocusTimeService,
  MAIL_FOCUS_JOB,
  ProposalService,
  type SchedulerLike,
  SchedulingService,
} from "../src/index.ts";
import { testDb } from "./helpers.ts";

/** Focus time (#953 item 3): one proposed block a week, a busy event only after approval. */

const SUNDAY = Date.parse("2026-10-25T18:00:00Z");
const DAY = 86_400_000;

interface FakeEvent {
  title: string;
  start: string;
  end: string;
  availability?: string;
}

function rig(options: { enabled?: boolean; readOnly?: boolean; events?: FakeEvent[] } = {}) {
  const clock = new FakeClock(SUNDAY);
  const db = testDb(clock);
  const broker = createPermissionBroker({
    clock,
    approvers: {
      device: async (id) => (id === "dev_mac" ? { scopes: ["operator.approvals"] } : undefined),
      isOwnerSender: async () => false,
    },
  });
  const events: FakeEvent[] = options.events ?? [];
  const writes: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const tools = new Map<string, AgentToolRegistration>([
    [
      "calendar_create_event",
      defineTool({
        name: "calendar_create_event",
        description: "Add an event",
        input: Type.Object({}, { additionalProperties: true }),
        sideEffect: "write",
        run: async (p) => {
          writes.push(p as Record<string, unknown>);
          events.push(p as unknown as FakeEvent);
          return { output: { ok: true }, provenance: "trusted" as const };
        },
      }),
    ],
    [
      "calendar_free_busy",
      defineTool({
        name: "calendar_free_busy",
        description: "Busy blocks",
        input: Type.Object({}, { additionalProperties: true }),
        sideEffect: "none",
        run: async () => {
          reads.push("calendar_free_busy");
          // A soft hold (availability "free") does not show as busy; everything else does.
          const busy = events
            .filter((e) => e.availability !== "free")
            .map((e) => ({ start: e.start, end: e.end }));
          return { output: { blocks: busy }, provenance: "untrusted" as const };
        },
      }),
    ],
    [
      "calendar_list_events",
      defineTool({
        name: "calendar_list_events",
        description: "Events",
        input: Type.Object({}, { additionalProperties: true }),
        sideEffect: "none",
        run: async (p) => {
          const q = String((p as { query?: unknown }).query ?? "").toLowerCase();
          return {
            output: { events: events.filter((e) => e.title.toLowerCase().includes(q)) },
            provenance: "untrusted" as const,
          };
        },
      }),
    ],
  ]);
  const lookup = { get: (n: string) => tools.get(n) };
  let n = 0;
  const proposals = new ProposalService({
    db: db.sqlite,
    clock,
    broker,
    tools: lookup,
    mainThread: async () => "thr_main",
    newId: () => `prop_${++n}`,
  });
  let enabled = options.enabled ?? true;
  const focus = new FocusTimeService({
    tools: lookup,
    proposals,
    enabled: () => enabled,
    readOnly: () => options.readOnly === true,
    timezone: "UTC",
    now: () => clock.now(),
  });
  const decide = async (id: string, decision: "approve" | "deny") => {
    const { issued } = await proposals.approve(id);
    clock.advance(500);
    await broker.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop ?? "",
      decision,
      scope: "once",
      decidedBy: { deviceId: "dev_mac", surface: "desktop" },
    });
    await proposals.idle();
  };
  return {
    clock,
    focus,
    proposals,
    events,
    writes,
    reads,
    lookup,
    decide,
    setEnabled: (v: boolean) => {
      enabled = v;
    },
  };
}

describe("focus time", () => {
  it("proposes nothing while mail.schedule.focusTime is off", async () => {
    const r = rig({ enabled: false });
    expect(await r.focus.run()).toEqual({ status: "off" });
    expect(r.proposals.list().proposals).toHaveLength(0);
    expect(r.writes).toEqual([]);
  });

  it("proposes nothing in read-only mode", async () => {
    const r = rig({ readOnly: true });
    expect(await r.focus.run()).toEqual({ status: "read_only" });
    expect(r.proposals.list().proposals).toHaveLength(0);
  });

  it("proposes one 2-hour block for the coming week as a pending proposal, not an event", async () => {
    const r = rig();
    const out = await r.focus.run();
    expect(out).toMatchObject({ status: "proposed" });
    const [p, ...rest] = r.proposals.list().proposals;
    expect(rest).toEqual([]);
    expect(p?.status).toBe("pending");
    expect(p?.createdBy.job).toBe("mail.focus");
    expect(p?.calls).toHaveLength(1);
    expect(p?.calls[0]).toMatchObject({
      tool: "calendar_create_event",
      params: {
        title: "Focus (Psyche)",
        start: "2026-10-26T09:00:00.000Z",
        end: "2026-10-26T11:00:00.000Z",
        availability: "busy",
      },
    });
    // Nothing reached the calendar: only an approval does that.
    expect(r.writes).toEqual([]);
    expect(r.events).toEqual([]);
  });

  it("proposes once per week, and again for the next week", async () => {
    const r = rig();
    expect((await r.focus.run()).status).toBe("proposed");
    expect((await r.focus.run()).status).toBe("already_offered");
    expect(r.proposals.list().proposals).toHaveLength(1);
    r.clock.advance(7 * DAY);
    const next = await r.focus.run();
    expect(next).toMatchObject({ status: "proposed", slot: { start: "2026-11-02T09:00:00.000Z" } });
    // The first card expired unanswered; the new week has its own pending one.
    expect(r.proposals.list().proposals).toHaveLength(1);
    expect(r.proposals.list({ status: ["expired"] }).proposals).toHaveLength(1);
  });

  it("keeps clear of busy time and the owner's buffer", async () => {
    const r = rig({
      events: [
        { title: "Standup", start: "2026-10-26T09:00:00.000Z", end: "2026-10-26T12:00:00.000Z" },
      ],
    });
    const out = await r.focus.run();
    // Busy until 12:00, a 15-minute buffer, then the next half-hour step.
    expect(out).toMatchObject({ status: "proposed", slot: { start: "2026-10-26T12:30:00.000Z" } });
  });

  it("does not create the event when the card is unapproved or declined", async () => {
    const r = rig();
    const out = await r.focus.run();
    expect(r.events).toEqual([]);
    if (out.status !== "proposed") throw new Error("expected a proposal");
    await r.decide(out.proposalId, "deny");
    expect(r.proposals.get(out.proposalId).status).toBe("dismissed");
    expect(r.writes).toEqual([]);
    expect(r.events).toEqual([]);
    // A decline is respected: the same week is not offered again.
    expect((await r.focus.run()).status).toBe("already_offered");
    expect(r.proposals.list({ status: ["pending"] }).proposals).toHaveLength(0);
  });

  it("creates the 'Focus (Psyche)' event, busy, once the owner approves", async () => {
    const r = rig();
    const out = await r.focus.run();
    if (out.status !== "proposed") throw new Error("expected a proposal");
    await r.decide(out.proposalId, "approve");
    expect(r.proposals.get(out.proposalId).status).toBe("done");
    expect(r.writes).toEqual([
      {
        title: FOCUS_EVENT_TITLE,
        start: "2026-10-26T09:00:00.000Z",
        end: "2026-10-26T11:00:00.000Z",
        availability: "busy",
      },
    ]);
  });

  it("does not propose a week that already has a 'Focus (Psyche)' event", async () => {
    const r = rig({
      events: [
        {
          title: "Focus (Psyche)",
          start: "2026-10-28T13:00:00.000Z",
          end: "2026-10-28T15:00:00.000Z",
        },
      ],
    });
    expect((await r.focus.run()).status).toBe("already_booked");
    expect(r.proposals.list().proposals).toHaveLength(0);
  });

  it("stops proposing when switched off and leaves existing events alone", async () => {
    const r = rig();
    const out = await r.focus.run();
    if (out.status !== "proposed") throw new Error("expected a proposal");
    await r.decide(out.proposalId, "approve");
    expect(r.events).toHaveLength(1);
    r.setEnabled(false);
    r.clock.advance(7 * DAY);
    expect((await r.focus.run()).status).toBe("off");
    expect(r.proposals.list().proposals).toHaveLength(0);
    expect(r.events).toHaveLength(1);
  });

  it("scheduling never offers the approved focus block, but still offers other times", async () => {
    const r = rig();
    const drafts = {
      draft: async () => ({ body: "", subject: "", to: [] }) as unknown as Draft,
    } as unknown as DraftService;
    const scheduling = new SchedulingService({
      tools: r.lookup,
      drafts,
      timezone: "UTC",
      now: () => r.clock.now(),
    });
    const ask = () =>
      scheduling.proposeTimes({ via: "apple", messageId: "m1", durationMin: 30, withinDays: 3 });
    // Without the focus block the first offer is Monday 09:00.
    expect((await ask()).slots[0]?.start).toBe("2026-10-26T09:00:00.000Z");
    const out = await r.focus.run();
    if (out.status !== "proposed") throw new Error("expected a proposal");
    // Proposed but not approved: still free.
    expect((await ask()).slots[0]?.start).toBe("2026-10-26T09:00:00.000Z");
    await r.decide(out.proposalId, "approve");
    const { slots } = await ask();
    const focusStart = Date.parse("2026-10-26T09:00:00.000Z");
    const focusEnd = Date.parse("2026-10-26T11:00:00.000Z");
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const a = Date.parse(s.start);
      const b = Date.parse(s.end);
      expect(a < focusEnd + 15 * 60_000 && b > focusStart - 15 * 60_000).toBe(false);
    }
    expect(slots[0]?.start).toBe("2026-10-26T11:30:00.000Z");
  });

  it("keeps the weekly automation in step with the switch", async () => {
    const r = rig();
    const automations: { id: string; prompt: string; enabled: boolean; schedule: string }[] = [];
    const scheduler = {
      list: async () => automations,
      create: async (input: { prompt: string; enabled: boolean; schedule: string }) => {
        const a = { id: `a${automations.length + 1}`, ...input };
        automations.push(a);
        return a;
      },
      update: async (id: string, patch: { enabled: boolean; schedule: string }) => {
        const a = automations.find((x) => x.id === id);
        if (a === undefined) throw new Error("missing");
        Object.assign(a, patch);
        return a;
      },
    } as unknown as SchedulerLike;
    const focus = new FocusTimeService({
      tools: r.lookup,
      proposals: r.proposals,
      scheduler,
      enabled: () => true,
      timezone: "America/Los_Angeles",
      now: () => r.clock.now(),
    });
    await focus.ensureSchedule({ enabled: false });
    await focus.ensureSchedule({ enabled: true });
    expect(automations).toHaveLength(1);
    expect(automations[0]).toMatchObject({
      prompt: `[psyche:${MAIL_FOCUS_JOB} weekly]`,
      schedule: "0 18 * * 0",
      enabled: true,
    });
    expect(focus.job().matches({ prompt: automations[0]?.prompt ?? "", kind: "cron" })).toBe(true);
  });
});
