import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMessagesPage, setSetting, updateDevice } from "@psyche/db";
import type { Message, ModelEvent, ModelProvider, ModelRequest } from "@psyche/protocol";
import { MEMORY_WORK_SETTING_KEY } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { GRAPH_SETTING } from "../src/compose/people.ts";
import { LEARN_SYSTEM, LEARN_WORK_ADDENDUM } from "../src/compose/user-profile.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/**
 * MW7 follow-up: the note under a chat turn that touched the owner's work. A proposal (a
 * deadline) stays pending in Review until an owner-scoped connection confirms it; a direct update
 * (progress) is written at once and can be undone. Every window sees the note; only a connection
 * with write scope can act on it.
 */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const reply = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  {
    type: "usage",
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

const PROGRESS = "I finished problems 1-3 of Lecture Work 7";
const DEADLINE = "Lecture Work 7 is due Friday";

function scripted(): ModelProvider {
  return {
    id: "scripted",
    capabilities: async () => ({ contextWindow: 64_000 }) as never,
    async *stream(req: ModelRequest) {
      if ((req.system ?? "").startsWith(LEARN_SYSTEM)) {
        const work = (req.system ?? "").includes(LEARN_WORK_ADDENDUM)
          ? {
              work: [
                {
                  item: "Lecture Work 7",
                  attribute: "progress",
                  value: "finished problems 1-3",
                  quote: PROGRESS,
                },
                {
                  item: "Lecture Work 7",
                  attribute: "deadline",
                  value: "2026-11-06",
                  quote: DEADLINE,
                },
              ],
            }
          : {};
        yield* reply(JSON.stringify({ facts: [], ...work }));
        return;
      }
      yield* reply("Got it.");
    },
  };
}

async function waitFor<T>(read: () => T | undefined, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("work note under a chat turn (Gateway)", () => {
  it("shows a proposal and an undoable update; only an owner-scoped connection may act", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-work-note-"));
    composed = await composeGateway({
      logger: silentLogger,
      clock: new FakeClock(Date.parse("2026-11-04T18:00:00Z")),
      timeZone: "UTC",
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: scripted(), model: "scripted/main", utilityModel: "scripted/utility" },
    });
    const gw = composed;
    setSetting(gw.db, GRAPH_SETTING, { enabled: true });
    setSetting(gw.db, MEMORY_WORK_SETTING_KEY, {
      enabled: true,
      consentedAt: "2026-11-01T00:00:00.000Z",
    });
    gw.people.sync({ enabled: true });
    const graph = gw.people.graph;
    const lw7 = graph.createEntity({
      kind: "assignment",
      name: "Lecture Work 7",
      dueAt: "2026-11-20T23:59:00Z",
    });

    const owner = await adminClient(gw.gateway);
    // A second window with read scope only (a remote viewer).
    const viewerKey = newDeviceKey();
    const first = await desktopClient(gw.gateway, viewerKey, "desk-viewer");
    first.close();
    updateDevice(gw.db, "desk-viewer", { scopes: ["operator.read"] });
    const viewer = await desktopClient(gw.gateway, viewerKey, "desk-viewer");
    clients.push(owner, viewer);

    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    await owner.call(
      "chat.send",
      { threadId: thread.id, content: `${PROGRESS}, and ${DEADLINE}.` },
      ik(),
    );
    await gw.gateway.context.sessions.idle();

    const noteOf = (m: Message) => m.blocks.find((b) => b.type === "work_note");
    const message = await waitFor(() =>
      listMessagesPage(gw.db, thread.id, { limit: 100 }).messages.find(
        (m) => m.role === "system" && noteOf(m) !== undefined,
      ),
    );
    const note = noteOf(message) as {
      type: "work_note";
      items: { kind: string; attribute: string; factId: string; name: string; value: string }[];
    };
    const proposal = note.items.find((i) => i.kind === "proposal");
    const update = note.items.find((i) => i.kind === "update");
    expect(proposal).toMatchObject({ attribute: "deadline", name: "Lecture Work 7" });
    expect(update).toMatchObject({ attribute: "progress", value: "finished problems 1-3" });
    // The note is a transcript message from Psyche, never the owner's.
    expect(message.provenance).toBe("agent");

    // Every window gets the note (the event the viewer sees carries the same block).
    const seen = await viewer.waitForEvent(
      (e) =>
        e.event === "chat.message" &&
        (e.payload as { message: Message }).message.blocks.some((b) => b.type === "work_note"),
    );
    expect(seen).toBeDefined();

    // Nothing was applied by the note: the deadline is unchanged and the proposal is pending.
    expect(graph.getEntity(lw7.id)?.dueAt).toBe("2026-11-20T23:59:00.000Z");
    const pending = await owner.call<{ items: { fact: { id: string } }[] }>(
      "memory.review.list",
      { state: ["pending"] },
      ik(),
    );
    expect(pending.items.map((i) => i.fact.id)).toContain(proposal?.factId);

    // A read-only window cannot confirm, discard or undo.
    for (const [method, params] of [
      ["memory.review.decide", { factIds: [proposal?.factId], decision: "confirm" }],
      ["memory.review.decide", { factIds: [proposal?.factId], decision: "discard" }],
      ["memory.work.undoUpdate", { factId: update?.factId }],
    ] as const) {
      expect(await viewer.request(method, params, ik())).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
    }
    expect(graph.getEntity(lw7.id)?.dueAt).toBe("2026-11-20T23:59:00.000Z");
    expect(graph.facts(lw7.id).some((f) => f.attribute === "progress")).toBe(true);

    // The owner's connection confirms through the Review method: only now does the date move.
    await owner.call(
      "memory.review.decide",
      { factIds: [proposal?.factId], decision: "confirm" },
      ik(),
    );
    expect(graph.getEntity(lw7.id)?.dueAt).toBe("2026-11-06T23:59:00.000Z");

    // History lists the chat update as undoable (a read-only window sees it too); the confirmed
    // deadline is listed but has no Undo.
    const listed = await viewer.call<{
      entries: { factId: string; attribute: string; origin: string; undoable: boolean }[];
    }>("memory.work.history", { entityId: lw7.id }, ik());
    expect(listed.entries.find((e) => e.factId === update?.factId)).toMatchObject({
      attribute: "progress",
      origin: "chat",
      undoable: true,
    });
    expect(listed.entries.filter((e) => e.undoable)).toHaveLength(1);

    // Undo takes the progress line back; a second undo says so.
    expect(await owner.call("memory.work.undoUpdate", { factId: update?.factId }, ik())).toEqual({
      status: "undone",
    });
    expect(graph.facts(lw7.id).some((f) => f.attribute === "progress")).toBe(false);
    expect(await owner.call("memory.work.undoUpdate", { factId: update?.factId }, ik())).toEqual({
      status: "already_undone",
    });
  }, 30_000);
});
