import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelEvent } from "@psyche/protocol";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphIngester } from "../src/graph/ingest.ts";
import {
  GRAPH_SYSTEM_PROMPT,
  GRAPH_SYSTEM_PROMPT_NO_LOOPS,
  runGraphModelPass,
} from "../src/graph/model-pass.ts";
import { GraphStore } from "../src/graph/store.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

const WORLD = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "graph", "world.json"),
    "utf8",
  ),
);

let env: TestEnv;
let graph: GraphStore;
let clock: FakeClock;
beforeEach(async () => {
  clock = new FakeClock(Date.parse(WORLD.now));
  env = await makeEnv({ clock });
  graph = new GraphStore({ sqlite: env.db.sqlite, clock });
  const ingest = new GraphIngester(graph, {
    ownerEmails: WORLD.owner.emails,
    ownerPhones: WORLD.owner.phones,
    clock,
  });
  ingest.ingestContacts(WORLD.contacts);
  ingest.ingestMail(WORLD.mails);
});
afterEach(async () => env.cleanup());

const reply = (json: unknown): ModelEvent[] => [
  { type: "text_delta", text: JSON.stringify(json) },
  {
    type: "usage",
    usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

describe("model pass while the promise ledger is on", () => {
  it("the prompt without loops still asks for everything else", () => {
    expect(GRAPH_SYSTEM_PROMPT).toContain('"loops"');
    expect(GRAPH_SYSTEM_PROMPT).toContain("- loops:");
    expect(GRAPH_SYSTEM_PROMPT_NO_LOOPS).not.toContain("loops");
    for (const keep of ['"summary"', '"facts"', '"gists"', '"status"', '"next_step"', "<data>"]) {
      expect(GRAPH_SYSTEM_PROMPT_NO_LOOPS).toContain(keep);
    }
  });

  async function pass(ledgerOn: boolean) {
    const sam = graph.search("Sam Lee", { limit: 5 }).find((s) => s.name === "Sam Lee")?.id ?? "";
    const out = graph
      .interactions(sam, { limit: 50 })
      .find((i) => i.direction === "out" && i.subject === "Re: Revised budget")?.id;
    const provider = FakeModelProvider.script([
      reply({
        summary: "Head of product at Acme.",
        facts: [{ attribute: "team", value: "Product", source: out, evidence: "the product team" }],
        // Even a model that writes a loop anyway must not get it stored.
        loops: [
          {
            direction: "i_owe",
            text: "Send Sam the revised budget",
            source: out,
            evidence: "I'll send the revised budget by Oct 28.",
          },
        ],
      }),
    ]);
    const report = await runGraphModelPass(
      graph,
      { provider, model: "ollama/qwen3:8b" },
      { clock, only: [sam], ...(ledgerOn ? { ledgerOn: true } : {}) },
    );
    return { sam, provider, report };
  }

  it("with the ledger on: the no-loops prompt, no loop written, facts and summary unchanged", async () => {
    const { sam, provider, report } = await pass(true);
    expect(provider.requests[0]?.system).toBe(GRAPH_SYSTEM_PROMPT_NO_LOOPS);
    expect(report).toMatchObject({ entities: 1, facts: 1, loops: 0 });
    expect(graph.loops({ entityId: sam })).toEqual([]);
    expect(graph.facts(sam).map((f) => f.attribute)).toContain("team");
    expect(graph.getEntity(sam)?.summary).toContain("Head of product");
  });

  it("with the ledger off: the same reply writes the loop (positive control)", async () => {
    const { sam, provider, report } = await pass(false);
    expect(provider.requests[0]?.system).toBe(GRAPH_SYSTEM_PROMPT);
    expect(report.loops).toBe(1);
    expect(graph.loops({ entityId: sam })).toHaveLength(1);
  });
});
