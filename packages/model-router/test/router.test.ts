import type { ModelEvent } from "@psyche/protocol";
import { collect, FakeClock, FakeCredentialBroker, FakeModelProvider } from "@psyche/testing";
import { describeModelProviderConformance } from "@psyche/testing/conformance";
import { describe, expect, it } from "vitest";
import {
  AiSdkAdapter,
  brokerKeySource,
  InMemoryProbeStore,
  InMemoryUsageRepository,
  ModelRouter,
  type ProbeResult,
  UsageLedger,
} from "../src/index.ts";
import { textRequest } from "./helpers/adapters.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.01 };
const ok = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason: "stop" },
];
const fail = (error: string): ModelEvent[] => [{ type: "finish", reason: "error", error }];

function setup(opts: { primary?: ModelEvent[][]; backup?: ModelEvent[][] } = {}) {
  const clock = new FakeClock();
  const primary = FakeModelProvider.script(opts.primary ?? [], { id: "alpha" });
  const backup = FakeModelProvider.script(opts.backup ?? [], { id: "beta" });
  const repo = new InMemoryUsageRepository();
  let n = 0;
  const ledger = new UsageLedger({ repo, clock, newId: () => `usage_${++n}` });
  const probes = new InMemoryProbeStore();
  const router = new ModelRouter({
    providers: [primary, backup],
    clock,
    ledger,
    probes,
    roles: { primary: { model: "alpha/big", fallbacks: ["beta/small"] } },
  });
  return { clock, primary, backup, router, repo, ledger, probes };
}

const texts = (events: ModelEvent[]) =>
  events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");

describe("ModelRouter", () => {
  it("resolves router/primary to the primary model", async () => {
    const { router, primary } = setup({ primary: [ok("from alpha")] });
    const events = await collect(router.stream(textRequest("router/primary")));
    expect(texts(events)).toBe("from alpha");
    expect(primary.requests[0]?.model).toBe("alpha/big");
  });

  it("falls back to the next model within one request on a pre-content failure", async () => {
    const { router, primary, backup, repo } = setup({
      primary: [fail("overloaded: Overloaded")],
      backup: [ok("from beta")],
    });
    const events = await collect(router.stream(textRequest("router/primary"), { runId: "run_1" }));
    expect(texts(events)).toBe("from beta");
    expect(events.filter((e) => e.type === "finish")).toEqual([{ type: "finish", reason: "stop" }]);
    expect(primary.requests).toHaveLength(1);
    expect(backup.requests[0]?.model).toBe("beta/small");
    expect(repo.rows).toEqual([
      expect.objectContaining({ modelRef: "beta/small", runId: "run_1" }),
    ]);
  });

  it("does not fall back once content reached the consumer", async () => {
    const { router, backup } = setup({
      primary: [[{ type: "text_delta", text: "partial" }, ...fail("server_error: reset")]],
      backup: [ok("from beta")],
    });
    const events = await collect(router.stream(textRequest("router/primary")));
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    expect(backup.requests).toHaveLength(0);
  });

  it("cools a failing provider down and tries it again after expiry", async () => {
    const { router, primary, backup, clock } = setup({
      primary: [fail("rate_limited: slow down"), ok("alpha again")],
      backup: [ok("beta 1"), ok("beta 2")],
    });
    await collect(router.stream(textRequest("router/primary")));
    // Second request inside the 30 s cooldown skips alpha entirely.
    expect(texts(await collect(router.stream(textRequest("router/primary"))))).toBe("beta 2");
    expect(primary.requests).toHaveLength(1);
    // A rate limit cools the profile; with one profile, the provider cools too.
    expect(
      router
        .health()
        .find((h) => h.id === "alpha")
        ?.cooldowns.map((c) => c.key),
    ).toEqual(["profile:alpha:default", "provider:alpha"]);
    clock.advance(30_001);
    expect(texts(await collect(router.stream(textRequest("router/primary"))))).toBe("alpha again");
    expect(primary.requests).toHaveLength(2);
    expect(backup.requests).toHaveLength(2);
  });

  it("escalates the cooldown on repeated failures", async () => {
    const { router, primary, clock } = setup({
      primary: [fail("server_error: a"), fail("server_error: b"), ok("alpha")],
      backup: [ok("b1"), ok("b2"), ok("b3")],
    });
    await collect(router.stream(textRequest("router/primary")));
    clock.advance(30_001);
    await collect(router.stream(textRequest("router/primary")));
    expect(primary.requests).toHaveLength(2);
    clock.advance(30_001); // second strike is 60 s: still cooling
    await collect(router.stream(textRequest("router/primary")));
    expect(primary.requests).toHaveLength(2);
  });

  it("strict mode never changes the model and fails visibly", async () => {
    const { router, backup } = setup({ primary: [fail("overloaded: Overloaded")] });
    const events = await collect(router.stream(textRequest("alpha/big"), { strict: true }));
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "finish", reason: "error" });
    expect(last?.type === "finish" && last.error).toMatch(/^overloaded: alpha\/big is pinned/);
    expect(backup.requests).toHaveLength(0);
  });

  it("applies a per-thread /model override strictly to that thread only", async () => {
    const { router, primary, backup } = setup({
      primary: [ok("alpha for other thread")],
      backup: [fail("server_error: down")],
    });
    await router.setThreadModel("thr_1", "beta/small");
    const pinned = await collect(
      router.stream(textRequest("router/primary"), { threadId: "thr_1" }),
    );
    expect(pinned.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    expect(primary.requests).toHaveLength(0);
    const other = await collect(
      router.stream(textRequest("router/primary"), { threadId: "thr_2" }),
    );
    expect(texts(other)).toBe("alpha for other thread");
    expect(backup.requests).toHaveLength(1);
  });

  it("does not fall back on a bad request", async () => {
    const { router, backup } = setup({ primary: [fail("bad_request: invalid tool schema")] });
    const events = await collect(router.stream(textRequest("router/primary")));
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    expect(backup.requests).toHaveLength(0);
  });

  it("falls back on context overflow without cooling the provider", async () => {
    const { router, backup } = setup({
      primary: [fail("context_overflow: prompt is too long")],
      backup: [ok("beta")],
    });
    await collect(router.stream(textRequest("router/primary")));
    expect(backup.requests).toHaveLength(1);
    expect(router.health().find((h) => h.id === "alpha")?.cooldowns).toHaveLength(0);
  });

  it("resolves utility to the primary chain when unbound and fails clearly for embedding", async () => {
    const { router, primary } = setup({ primary: [ok("u")] });
    await collect(router.stream(textRequest("router/utility")));
    expect(primary.requests[0]?.model).toBe("alpha/big");
    const events = await collect(router.stream(textRequest("router/speech")));
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
  });

  it("uses a bound role over the primary chain", async () => {
    const { router, backup } = setup({ backup: [ok("cheap")] });
    await router.setRole("utility", { model: "beta/small" });
    await collect(router.stream(textRequest("router/utility")));
    expect(backup.requests[0]?.model).toBe("beta/small");
  });

  it("lets prepareStep swap the model, except for pinned models", async () => {
    const { router, primary, backup } = setup({ primary: [ok("a")], backup: [ok("b")] });
    const prepareStep = ({ step }: { step: number }) =>
      step > 0 ? { model: "beta/small" } : undefined;
    await collect(router.stream(textRequest("router/primary"), { step: 1, prepareStep }));
    expect(backup.requests).toHaveLength(1);
    await collect(router.stream(textRequest("alpha/big"), { step: 1, prepareStep, strict: true }));
    expect(primary.requests).toHaveLength(1);
  });

  it("refuses a chat-only model as primary without an override (B4)", async () => {
    const { router, probes } = setup();
    const chatOnly: ProbeResult = {
      ref: "beta/small",
      status: "chat-only",
      passed: 2,
      total: 6,
      inconclusive: false,
      cases: [],
      probedAt: new Date(0).toISOString(),
    };
    probes.set(chatOnly);
    await expect(router.setRole("primary", { model: "beta/small" })).rejects.toMatchObject({
      code: "policy_denied",
    });
    await expect(router.setThreadModel("t", "beta/small")).rejects.toMatchObject({
      code: "policy_denied",
    });
    await router.setRole("primary", { model: "beta/small" }, { override: true });
    expect(router.role("primary")?.model).toBe("beta/small");
    expect((await router.capabilities("beta/small")).toolCalling).toBe(false);
  });

  it("ends with finish{cancelled} when aborted before the call", async () => {
    const { router, primary } = setup();
    const ac = new AbortController();
    ac.abort();
    const events = await collect(
      router.stream(textRequest("router/primary"), { signal: ac.signal }),
    );
    expect(events).toEqual([{ type: "finish", reason: "cancelled" }]);
    expect(primary.requests).toHaveLength(0);
  });

  it("caps auto permission mode to allowlisted models", () => {
    const { router } = setup();
    expect(router.allowsAutoMode("anthropic/claude-opus-5-5")).toBe(true);
    expect(router.allowsAutoMode("ollama/qwen3.8:27b")).toBe(false);
  });

  it("embeds through the embedding role and reports the dimension", async () => {
    const { router } = setup();
    await router.setRole("embedding", { model: "alpha/embed" });
    const v = await router.embed(["one", "two"]);
    expect(v).toHaveLength(2);
    expect(await router.embeddingInfo()).toEqual({ model: "alpha/embed", dimensions: 8 });
  });
});

describe("auth-profile rotation", () => {
  it("rotates to the next profile on 429 before falling back, then remembers", async () => {
    const replay = replayFetch(
      loadFixture("anthropic/error-429.json"),
      loadFixture("anthropic/text.json"),
      loadFixture("anthropic/text.json"),
    );
    const broker = new FakeCredentialBroker();
    for (const slug of ["anthropic-one", "anthropic-two"]) {
      broker.add({
        slug,
        kind: "api_key",
        bindings: [{ origin: "https://api.anthropic.com" }],
        secret: `sk-ant-${slug}-000111`,
      });
      broker.approve(`appr_${slug}`, { slug, origin: "https://api.anthropic.com", scope: "site" });
    }
    const adapter = new AiSdkAdapter(
      {
        id: "anthropic",
        kind: "anthropic",
        profiles: [
          { id: "one", credential: "{{cred:anthropic-one}}", approvalId: "appr_anthropic-one" },
          { id: "two", credential: "{{cred:anthropic-two}}", approvalId: "appr_anthropic-two" },
        ],
      },
      { keys: brokerKeySource(broker), fetch: replay.fetch },
    );
    const backup = FakeModelProvider.script([], { id: "beta" });
    const router = new ModelRouter({
      providers: [adapter, backup],
      clock: new FakeClock(),
      roles: { primary: { model: "anthropic/claude-sonnet-5-5", fallbacks: ["beta/small"] } },
    });
    const first = await collect(router.stream(textRequest("router/primary")));
    expect(first.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(replay.requests.map((r) => r.headers["x-api-key"])).toEqual([
      "sk-ant-anthropic-one-000111",
      "sk-ant-anthropic-two-000111",
    ]);
    expect(backup.requests).toHaveLength(0);
    // Profile one is cooling (retry-after 17 s): the next request starts with profile two.
    await collect(router.stream(textRequest("router/primary")));
    expect(replay.requests[2]?.headers["x-api-key"]).toBe("sk-ant-anthropic-two-000111");
  });
});

describeModelProviderConformance(
  "ModelRouter over FakeModelProvider",
  () => {
    const fake = new FakeModelProvider({ id: "alpha" });
    return new ModelRouter({
      providers: [fake],
      clock: new FakeClock(),
      roles: { primary: { model: "alpha/big" }, embedding: { model: "alpha/embed" } },
    });
  },
  {
    request: () => textRequest("router/primary"),
  },
);
