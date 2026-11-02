import type { ModelProvider } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  createSearchIndex,
  guardPlan,
  parseModelPlan,
  QueryModel,
  refineWithModel,
  rulesUnsure,
  understand,
} from "../src/index.ts";

const NOW = Date.parse("2026-10-20T17:00:00Z");
const TZ = -420;
const ctx = { now: NOW, tzOffsetMinutes: TZ };
const M = "m" as never;

function fake(reply: string | Error) {
  let calls = 0;
  const provider = {
    async *stream() {
      calls += 1;
      if (reply instanceof Error) throw reply;
      yield { type: "text_delta", text: reply };
      yield { type: "finish", reason: "stop" };
    },
  } as unknown as ModelProvider;
  return { provider, calls: () => calls };
}

const PLAN = {
  terms: ["lease", "deposit"],
  after: "2026-09-01",
  before: "2026-09-30",
  people: ["Priya"],
  sources: ["mail"],
  intent: "answer",
};

describe("parseModelPlan", () => {
  it("accepts the schema and tolerates a code fence", () => {
    const p = parseModelPlan(`\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``);
    expect(p).toMatchObject({ after: "2026-09-01", before: "2026-09-30", people: ["Priya"] });
    expect(p?.sources).toEqual(["mail"]);
  });
  it("drops bad dates, unknown sources and inverted ranges", () => {
    const p = parseModelPlan(
      JSON.stringify({ terms: [], after: "tomorrow", before: "2026-01-01", sources: ["slack"] }),
    );
    expect(p?.after).toBeUndefined();
    expect(p?.sources).toEqual([]);
    const inv = parseModelPlan(JSON.stringify({ after: "2026-10-01", before: "2026-01-01" }));
    expect(inv?.after).toBeUndefined();
    expect(inv?.before).toBeUndefined();
  });
  it("returns undefined for non-JSON", () => {
    expect(parseModelPlan("sorry")).toBeUndefined();
  });
});

describe("refineWithModel", () => {
  const q = "the lease deposit situation around the start of September, Priya knows";
  it("is only for questions the rules left unfiltered", () => {
    expect(rulesUnsure(q, understand(q, ctx))).toBe(true);
    const settled = "what did the landlord send last week about parking";
    expect(rulesUnsure(settled, understand(settled, ctx))).toBe(false);
    expect(rulesUnsure("lease", understand("lease", ctx))).toBe(false);
  });

  it("produces the same filter tokens as the rules and keeps the rules ladder", async () => {
    const m = new QueryModel({ provider: fake(JSON.stringify(PLAN)).provider, model: M });
    const r = await refineWithModel(q, understand(q, ctx), m, ctx);
    // The question only mentions Priya as the topic and names no source: both filters are dropped.
    expect(r?.attempts[0]?.q).toBe("after:2026-09-01 before:2026-09-30 lease OR deposit");
    expect(r?.intent).toBe("answer");
    expect(r?.attempts.length).toBeGreaterThan(1);
    expect(r?.chips.map((c) => c.kind)).toEqual(["time"]);
  });

  it("keeps a person and a source only when the question asks for them", () => {
    const plan = {
      ...PLAN,
      intent: "answer" as const,
      people: ["Priya", "Sam"],
      sources: ["mail", "imessage", "files"],
    };
    expect(guardPlan(plan, "email from Priya about the lease, Sam knows").people).toEqual([
      "Priya",
    ]);
    expect(guardPlan(plan, "what Priya wrote about the lease").people).toEqual(["Priya"]);
    expect(guardPlan(plan, "did Sam pay Priya back").people).toEqual([]);
    expect(guardPlan(plan, "my email and the documents in my chats").sources).toEqual(["mail"]);
    expect(guardPlan(plan, "which chats and documents mention it").sources).toEqual([]);
    expect(guardPlan(plan, "texts about the pdf").sources).toEqual(["imessage", "files"]);
    expect(guardPlan(plan, "email from Priya").after).toBe("2026-09-01");
  });

  it("caches per normalised question", async () => {
    const f = fake(JSON.stringify(PLAN));
    const m = new QueryModel({ provider: f.provider, model: M });
    await refineWithModel(q, understand(q, ctx), m, ctx);
    await refineWithModel(`  ${q.toUpperCase()} `, understand(q, ctx), m, ctx);
    expect(f.calls()).toBe(1);
  });

  it("falls back to the rules on errors and junk", async () => {
    for (const reply of [new Error("down"), "not json"]) {
      const m = new QueryModel({ provider: fake(reply).provider, model: M });
      expect(await refineWithModel(q, understand(q, ctx), m, ctx)).toBeUndefined();
    }
  });
});

describe("index.search with smart", () => {
  const docs = [
    { id: "a", text: "Priya: deposit due", at: "2026-09-10" },
    { id: "b", text: "Priya: deposit refund", at: "2026-03-10" },
  ];
  const make = async (reply: string, enabled = true) => {
    const f = fake(reply);
    const index = createSearchIndex({
      now: () => NOW,
      tzOffsetMinutes: TZ,
      queryModel: {
        model: new QueryModel({ provider: f.provider, model: M }),
        enabled: () => enabled,
      },
    });
    await index.indexMany(
      docs.map((d) => ({
        id: d.id,
        kind: "library" as const,
        title: "Lease deposit",
        text: d.text,
        provenance: "owner" as const,
        createdAt: Date.parse(d.at),
      })),
    );
    return { index, f };
  };
  const ask = "what happened with that lease deposit around the start of September";
  const timeOnly = JSON.stringify({ ...PLAN, people: [], sources: [] });

  it("uses the model reading only when smart is set", async () => {
    const { index, f } = await make(timeOnly);
    const plain = await index.search({ q: ask });
    expect(f.calls()).toBe(0);
    expect(plain.hits.map((h) => h.id).sort()).toEqual(["a", "b"]);
    const smart = await index.search({ q: ask, smart: true });
    expect(f.calls()).toBe(1);
    expect(smart.hits.map((h) => h.id)).toEqual(["a"]);
    expect(smart.understood?.chips[0]?.kind).toBe("time");
  });

  it("is off when disabled, and falls back to the rules when the model fails", async () => {
    const off = await make(timeOnly, false);
    await off.index.search({ q: ask, smart: true });
    expect(off.f.calls()).toBe(0);
    const bad = await make("nope");
    const res = await bad.index.search({ q: ask, smart: true });
    expect(res.hits.length).toBe(2);
  });
});
