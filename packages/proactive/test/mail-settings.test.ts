import { type AgentToolRegistration, defineTool } from "@psyche/agent-core";
import type { ModelEvent, ModelRef } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { type Draft, DraftService, SchedulingService } from "../src/index.ts";

/** Settings → Mail & meetings that the drafting and scheduling services read on every run (#842). */

const T0 = Date.parse("2026-10-26T08:00:00Z"); // a Monday

function say(text: string): ModelEvent[] {
  return [
    { type: "text_delta", text },
    {
      type: "finish",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    } as unknown as ModelEvent,
  ];
}

function tool(name: string, run: (p: Record<string, unknown>) => unknown): AgentToolRegistration {
  return defineTool({
    name,
    description: name,
    input: Type.Object({}, { additionalProperties: true }),
    sideEffect: "read",
    run: async (p) => ({ output: run(p as Record<string, unknown>), provenance: "untrusted" }),
  });
}

const inbox = {
  id: "in1",
  from: "Lee Park <colleague1@acme.example>",
  subject: "Bug",
  body: "Can you look at the login bug today?",
  to: ["sam@acme.example"],
};

function draftRig(draftModel?: () => ModelRef | undefined) {
  const tools = new Map<string, AgentToolRegistration>([
    [
      "mail_read",
      tool("mail_read", () => ({
        body: inbox.body,
        to: inbox.to,
        summary: { from: inbox.from, subject: inbox.subject },
      })),
    ],
  ]);
  const provider = new FakeModelProvider({ id: "router" });
  provider.enqueue(() => say(JSON.stringify({ body: "On it.\n\n— S" })));
  const service = new DraftService({
    tools: { get: (n: string) => tools.get(n) },
    provider,
    model: "router/primary",
    ...(draftModel === undefined ? {} : { draftModel }),
    ownerAddresses: async () => ["sam@acme.example"],
  });
  return { service, provider };
}

describe("Draft with a local model (mail.draft.localModel)", () => {
  it("sends the draft to the pinned local ref instead of the primary model", async () => {
    const r = draftRig(() => "ollama/qwen3-8b" as ModelRef);
    const d: Draft = await r.service.draft({ via: "apple", messageId: "in1" });
    expect(d.body).toContain("On it.");
    expect(r.provider.requests.at(-1)?.model).toBe("ollama/qwen3-8b");
  });

  it("keeps the primary model when nothing is pinned", async () => {
    const r = draftRig(() => undefined);
    await r.service.draft({ via: "apple", messageId: "in1" });
    expect(r.provider.requests.at(-1)?.model).toBe("router/primary");
  });
});

describe("Scheduling settings (mail.schedule.*)", () => {
  it("offers only times inside the owner's working hours, with the owner's buffer", async () => {
    // Busy 10:00–10:30 UTC; the 30-minute buffer keeps 09:30–11:00 clear, so the first slot is 11:00.
    const busy = [{ start: "2026-10-27T10:00:00.000Z", end: "2026-10-27T10:30:00.000Z" }];
    const tools = new Map<string, AgentToolRegistration>([
      ["calendar_free_busy", tool("calendar_free_busy", () => ({ busy }))],
    ]);
    const drafts = {
      draft: async () => ({ body: "", subject: "", to: [] }) as unknown as Draft,
    } as unknown as DraftService;
    const scheduling = new SchedulingService({
      tools: { get: (n: string) => tools.get(n) },
      drafts,
      timezone: "UTC",
      now: () => T0,
      schedule: () => ({ workingHours: { start: 10, end: 12 }, bufferMin: 30 }),
    });
    const { slots } = await scheduling.proposeTimes({
      via: "apple",
      messageId: "in1",
      durationMin: 30,
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const hour = new Date(slot.start).getUTCHours();
      expect(hour).toBeGreaterThanOrEqual(10);
      expect(hour).toBeLessThan(12);
    }
    // The Tuesday busy block 10:00–10:30 plus a 30-minute buffer clears the first slot until 11:00.
    expect(slots.map((s) => s.start)).not.toContain("2026-10-27T10:00:00.000Z");
    expect(slots.find((s) => s.start.startsWith("2026-10-27"))?.start).toBe(
      "2026-10-27T11:00:00.000Z",
    );
  });
});
