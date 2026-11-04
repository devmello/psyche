import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSetting } from "@psyche/db";
import type { ModelEvent, ModelProvider, ModelRequest } from "@psyche/protocol";
import { MEMORY_WORK_SETTING_KEY } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { GRAPH_SETTING } from "../src/compose/people.ts";
import {
  LEARN_SYSTEM,
  LEARN_WORK_ADDENDUM,
  looksLikeWork,
  todayLine,
} from "../src/compose/user-profile.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * The owner's own chat updates their work (MW7, docs/design/memory-everything-2026.md §3.1): the
 * USER.md learner gains a `work` output, asked for only when the message looks like work and the
 * graph is on. The model proposes; code resolves the item, verifies the quote and writes a cited
 * owner-stated fact.
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

const QUOTE = "I finished problems 1-3 of Lecture Work 7";

function scripted() {
  const calls: { system: string; text: string }[] = [];
  const p: ModelProvider & { calls: typeof calls } = {
    id: "scripted",
    calls,
    capabilities: async () => ({ contextWindow: 64_000 }) as never,
    async *stream(req: ModelRequest) {
      if ((req.system ?? "").startsWith(LEARN_SYSTEM)) {
        const part = req.messages[0]?.parts[0];
        const text = part?.type === "text" ? part.text : "";
        calls.push({ system: req.system ?? "", text });
        // The work keys exist only when the addendum was asked for.
        const work = (req.system ?? "").includes(LEARN_WORK_ADDENDUM)
          ? {
              work: [
                {
                  item: "Lecture Work 7",
                  attribute: "progress",
                  value: "finished problems 1-3",
                  quote: QUOTE,
                },
                // Not in the owner's message: must never land.
                {
                  item: "Lecture Work 7",
                  attribute: "status",
                  value: "done",
                  quote: "I handed in Lecture Work 7 yesterday",
                },
              ],
              assignments: [
                {
                  title: "Poster",
                  due: "2026-11-06",
                  parent: null,
                  quote: "poster due Friday",
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
  return p;
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

describe("learner work output helpers", () => {
  it("asks for work only when the message looks like work, and gives today's date", () => {
    expect(looksLikeWork("I finished problems 1-3 of the lab report")).toBe(true);
    expect(looksLikeWork("the deck is due Friday now")).toBe(true);
    expect(looksLikeWork("I stopped at part b")).toBe(true);
    expect(looksLikeWork("I always prefer tea over coffee")).toBe(false);
    expect(todayLine(Date.parse("2026-11-04T18:00:00Z"), "America/Los_Angeles")).toBe(
      "Today is Wednesday 2026-11-04 (America/Los_Angeles).",
    );
    expect(todayLine(Date.parse("2026-11-04T18:00:00Z"), "Not/AZone")).toBe(
      "Today is Wednesday 2026-11-04 (UTC).",
    );
  });
});

describe("owner chat updates work (Gateway)", () => {
  it("writes cited progress, never an unquoted status, and only when the graph is on", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-user-work-"));
    const model = scripted();
    composed = await composeGateway({
      logger: silentLogger,
      clock: new FakeClock(Date.parse("2026-11-04T18:00:00Z")),
      timeZone: "UTC",
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: model, model: "scripted/main", utilityModel: "scripted/utility" },
    });
    const gw = composed;
    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const turn = async (content: string) => {
      await owner.call("chat.send", { threadId: thread.id, content }, ik());
      await gw.gateway.context.sessions.idle();
    };

    // The graph is off: the learner is the plain one and no work is written.
    await turn("I finished problems 1-3 of Lecture Work 7.");
    await waitFor(() => (model.calls.length > 0 ? true : undefined));
    expect(model.calls[0]?.system).toBe(LEARN_SYSTEM);
    expect(model.calls[0]?.text).not.toContain("Today is");

    // The graph is on, with one open to-do.
    setSetting(gw.db, GRAPH_SETTING, { enabled: true });
    gw.people.sync({ enabled: true });
    const graph = gw.people.graph;
    const lw7 = graph.createEntity({
      kind: "assignment",
      name: "Lecture Work 7",
      dueAt: "2026-11-06T23:59:00Z",
    });
    const noConsent = model.calls.length;
    await turn("I finished problems 1-3 of Lecture Work 7 today.");
    await waitFor(() => (model.calls.length > noConsent ? true : undefined));
    expect(model.calls.at(-1)?.system).toBe(LEARN_SYSTEM);
    expect(graph.facts(lw7.id).filter((f) => f.attribute === "progress")).toEqual([]);

    // With the owner's consent the learner asks for work.
    setSetting(gw.db, MEMORY_WORK_SETTING_KEY, {
      enabled: true,
      consentedAt: "2026-11-01T00:00:00.000Z",
    });
    const before = model.calls.length;
    await turn(`${QUOTE}, and the poster due Friday is next.`);
    await waitFor(() => (model.calls.length > before ? true : undefined));
    const call = model.calls.at(-1);
    expect(call?.system).toBe(`${LEARN_SYSTEM}${LEARN_WORK_ADDENDUM}`);
    expect(call?.text).toMatch(/^Today is \w+day \d{4}-\d{2}-\d{2} \(\S+\)\./);

    const progress = await waitFor(() => {
      const f = graph.facts(lw7.id).find((x) => x.attribute === "progress");
      return f;
    });
    expect(progress).toMatchObject({
      value: "finished problems 1-3",
      provenance: "owner",
      subjectKind: "owner_stated",
      evidence: QUOTE,
    });
    expect(progress.sources).toContain(`chat:${thread.id}`);
    // The model's "done" had a quote that is not in the message: the status is code's, and it
    // only moved because progress was an owner signal.
    expect(graph.getEntity(lw7.id)).toMatchObject({ workStatus: "in_progress" });
    // The owner said they have a poster due Friday, quoted verbatim: an accepted to-do, cited.
    const poster = graph.listEntities(["assignment"]).find((e) => e.name === "Poster");
    expect(poster).toMatchObject({ dueAt: "2026-11-06T23:59:00.000Z", workStatus: "not_started" });
    expect(graph.facts(poster?.id as string).find((f) => f.attribute === "deadline")).toMatchObject(
      { provenance: "owner", evidence: "poster due Friday" },
    );
    // The audit names kinds and counts, never the text.
    const audits = await gw.audit.list({ kind: "memory.user_profile.work" });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain("problems");
  }, 30_000);
});
