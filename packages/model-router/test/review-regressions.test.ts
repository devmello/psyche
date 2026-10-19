/** Regression tests for the pre-PR review of S03 (one per finding). */
import type { ModelEvent } from "@psyche/protocol";
import { collect, FakeClock, FakeModelProvider } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  type CallOutcome,
  InMemoryProbeStore,
  ModelRouter,
  normalizeUsage,
  type UsageAggregate,
  UsageLedger,
} from "../src/index.ts";
import { makeAdapter, textRequest } from "./helpers/adapters.ts";
import { type Fixture, loadFixture, replayFetch } from "./helpers/replay.ts";

const KEY = { secret: "sk-ant-review-key-998877", origin: "https://api.anthropic.com" };
const REF = "anthropic/claude-sonnet-5-5";

describe("review regressions", () => {
  it("sends keyed requests with redirect: error (no key on a cross-origin hop)", async () => {
    const replay = replayFetch(loadFixture("anthropic/text.json"));
    const { adapter } = makeAdapter({ id: "anthropic", kind: "anthropic" }, replay.fetch, KEY);
    await collect(adapter.stream(textRequest(REF)));
    expect(replay.requests[0]?.redirect).toBe("error");
  });

  it("redacts secrets in errors streamed mid-response", async () => {
    const start = loadFixture("anthropic/overloaded-midstream.json");
    const chunks = (start.response.chunks ?? []).map((c) =>
      c.replace("Overloaded", `bad key ${KEY.secret}`),
    );
    const fx: Fixture = { ...start, response: { ...start.response, chunks } };
    const { adapter } = makeAdapter(
      { id: "anthropic", kind: "anthropic" },
      replayFetch(fx).fetch,
      KEY,
    );
    const events = await collect(adapter.stream(textRequest(REF)));
    expect(JSON.stringify(events)).not.toContain(KEY.secret);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
  });

  it("maps a request it cannot build to bad_request without cooling the provider", async () => {
    const replay = replayFetch();
    const { adapter } = makeAdapter({ id: "anthropic", kind: "anthropic" }, replay.fetch);
    const router = new ModelRouter({
      providers: [adapter],
      clock: new FakeClock(),
      roles: { primary: { model: REF } },
    });
    const req = textRequest("router/primary");
    req.messages.push({
      role: "user",
      parts: [{ type: "image", mime: "image/png", url: "not a url" }],
    });
    const events = await collect(router.stream(req));
    const last = events.at(-1);
    expect(last?.type === "finish" && last.error).toMatch(/^bad_request:/);
    expect(router.health()[0]?.cooldowns).toEqual([]);
    expect(replay.requests).toHaveLength(0);
  });

  it("does not count consumer time as provider silence", async () => {
    const replay = replayFetch(loadFixture("anthropic/text.json"));
    const { adapter } = makeAdapter(
      { id: "anthropic", kind: "anthropic", timeouts: { firstEventMs: 2_000, idleMs: 40 } },
      replay.fetch,
    );
    let outcome: CallOutcome | undefined;
    const events: ModelEvent[] = [];
    for await (const e of adapter.stream(textRequest(REF), {
      onOutcome: (o) => {
        outcome = o;
      },
    })) {
      events.push(e);
      if (e.type === "text_delta") await new Promise((r) => setTimeout(r, 80));
    }
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(outcome?.error).toBeUndefined();
  });

  it("keeps the stream contract when the ledger throws", async () => {
    const fake = new FakeModelProvider({ id: "alpha" });
    const repo = {
      insert: () => {
        throw new Error("SQLITE_BUSY");
      },
      aggregate: (): UsageAggregate[] => [],
    };
    const router = new ModelRouter({
      providers: [fake],
      clock: new FakeClock(),
      ledger: new UsageLedger({ repo, clock: new FakeClock(), newId: () => "u1" }),
      roles: { primary: { model: "alpha/big" } },
    });
    const events = await collect(router.stream(textRequest("router/primary")));
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  });

  it("rejects malformed role bindings at construction", () => {
    expect(
      () =>
        new ModelRouter({
          providers: [],
          clock: new FakeClock(),
          roles: { primary: { model: "nope" } },
        }),
    ).toThrow(/invalid model ref/);
  });

  it("does not store an inconclusive probe (server down)", async () => {
    const down: ModelEvent[] = [{ type: "finish", reason: "error", error: "network: refused" }];
    const fake = FakeModelProvider.script(Array(6).fill(down), { id: "ollama" });
    const probes = new InMemoryProbeStore();
    const router = new ModelRouter({ providers: [fake], clock: new FakeClock(), probes });
    const r = await router.probe("ollama/qwen3.8:27b");
    expect(r.inconclusive).toBe(true);
    expect(probes.get("ollama/qwen3.8:27b")).toBeUndefined();
  });

  it("does not double count cache writes when noCache includes them (OpenRouter)", () => {
    const u = normalizeUsage({
      inputTokens: { total: 1000, noCache: 800, cacheRead: 200, cacheWrite: 300 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    });
    expect(u.input + u.cacheRead + u.cacheWrite).toBe(1000);
  });

  it("honours strict on a role ref: no fallbacks", async () => {
    const alpha = FakeModelProvider.script(
      [[{ type: "finish", reason: "error", error: "overloaded: x" }]],
      { id: "alpha" },
    );
    const beta = new FakeModelProvider({ id: "beta" });
    const router = new ModelRouter({
      providers: [alpha, beta],
      clock: new FakeClock(),
      roles: { primary: { model: "alpha/big", fallbacks: ["beta/small"] } },
    });
    const events = await collect(router.stream(textRequest("router/primary"), { strict: true }));
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    expect(beta.requests).toHaveLength(0);
  });
});
