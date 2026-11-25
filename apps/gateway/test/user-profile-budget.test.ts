import { createThread, openDb } from "@psyche/db";
import { ModelRouter } from "@psyche/model-router";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { SecretRedactor } from "@psyche/vault";
import { describe, expect, it } from "vitest";
import {
  cheapLearnerModel,
  createUserProfile,
  LEARNER_DAILY_CAP,
  LEARNER_USAGE_SETTING,
} from "../src/compose/user-profile.ts";

/**
 * The chat learner is cheap by construction (memory audit P7): a deterministic gate before any
 * call, a daily cap that persists, and a cheap model only. With no cheap model it does not learn
 * from chats; it never falls back to the primary.
 */

const FACT = "My sister Maya lives in Lisbon";

function router(kind: string, primary: string, utility?: string, baseURL?: string) {
  const provider = new FakeModelProvider({ id: kind });
  Object.assign(provider, { config: { id: kind, kind, baseURL } });
  const r = new ModelRouter({
    providers: [provider],
    clock: new FakeClock(),
    roles: {
      primary: { model: primary },
      ...(utility === undefined ? {} : { utility: { model: utility } }),
    },
  });
  return { provider, router: r };
}

function setup(
  over: {
    provider?: FakeModelProvider;
    cheapModel?: () => string | undefined;
    dailyCap?: number;
    db?: ReturnType<typeof openDb>;
    now?: () => number;
  } = {},
) {
  const db = over.db ?? openDb(":memory:");
  const provider = over.provider ?? new FakeModelProvider({ id: "fake" });
  const warnings: string[] = [];
  const profile = createUserProfile({
    db,
    home: "/nonexistent",
    memory: {} as never,
    provider,
    model: "router/utility",
    active: true,
    ...(over.cheapModel === undefined ? {} : { cheapModel: over.cheapModel }),
    ...(over.dailyCap === undefined ? {} : { dailyCap: over.dailyCap }),
    now: over.now ?? (() => Date.UTC(2026, 10, 25, 12)),
    timeZone: () => "UTC",
    redactor: new SecretRedactor() as never,
    audit: { append: async () => undefined } as never,
    broker: {} as never,
    surfaces: ["desktop"],
    publish: () => undefined,
    logger: { log: (_l, msg) => void warnings.push(msg) },
  });
  const id = db.newId();
  createThread(db, { id, kind: "side", sessionKey: `k:${id}` } as never);
  const turn = (ownerText: string) =>
    profile.onOwnerTurn({ threadId: id, runId: `run_${db.newId()}`, ownerText });
  return { db, provider, profile, turn, warnings };
}

describe("cheap model only", () => {
  it("on Anthropic the learner calls the cheap model, never the primary", async () => {
    const { provider, router: r } = router("anthropic", "anthropic/claude-opus-5-5");
    const s = setup({
      provider: r as never,
      cheapModel: () => cheapLearnerModel(r),
    });
    await s.turn(FACT);
    expect(provider.requests.map((q) => q.model)).toEqual(["anthropic/claude-haiku-5-5"]);
    expect(s.profile.status()).toMatchObject({ mode: "on", model: "anthropic/claude-haiku-5-5" });
  });

  it("with no cheap model (no listed cheap tier) it makes no call and never uses the primary", async () => {
    const { provider, router: r } = router("openai", "openai/gpt-6-sol");
    expect(r.utilityRef()).toBeUndefined();
    const s = setup({ provider: r as never, cheapModel: () => cheapLearnerModel(r) });
    await s.turn(FACT);
    await s.turn("I work at Acme as a data engineer");
    expect(provider.requests).toHaveLength(0);
    expect(s.profile.status().mode).toBe("off_no_cheap_model");
    // Said once in the log, not once per message.
    expect(s.warnings.filter((w) => w.includes("no cheap model"))).toHaveLength(1);
  });

  it("a free local primary that stands in for the utility role is the primary: no call", async () => {
    const { provider, router: r } = router("ollama", "ollama/llama3");
    expect(r.utilityRef()).toBe("ollama/llama3");
    expect(cheapLearnerModel(r)).toBeUndefined();
    const s = setup({ provider: r as never, cheapModel: () => cheapLearnerModel(r) });
    await s.turn(FACT);
    expect(provider.requests).toHaveLength(0);
  });

  it("the owner's own utility pick is used, even on a local server", async () => {
    const { provider, router: r } = router("ollama", "ollama/llama3", "ollama/tiny");
    const s = setup({ provider: r as never, cheapModel: () => cheapLearnerModel(r) });
    await s.turn(FACT);
    expect(provider.requests.map((q) => q.model)).toEqual(["ollama/tiny"]);
  });

  it("a custom endpoint derives no cheap model: no call", async () => {
    const { provider, router: r } = router(
      "anthropic",
      "anthropic/claude-opus-5-5",
      undefined,
      "https://proxy.example/v1",
    );
    const s = setup({ provider: r as never, cheapModel: () => cheapLearnerModel(r) });
    await s.turn(FACT);
    expect(provider.requests).toHaveLength(0);
  });

  it("a message with no cue never reaches the model, even with a cheap one", async () => {
    const s = setup();
    await s.turn("what's the weather like in Paris");
    await s.turn("thanks, that was really helpful");
    expect(s.provider.requests).toHaveLength(0);
    await s.turn(FACT);
    expect(s.provider.requests).toHaveLength(1);
  });
});

describe("daily cap", () => {
  const day = (n: number) => Date.UTC(2026, 10, 25 + n, 12);

  it("defaults to 150 calls a day", () => {
    expect(LEARNER_DAILY_CAP).toBe(150);
  });

  it("stops quietly at the cap and resumes the next local day", async () => {
    let now = day(0);
    const s = setup({ dailyCap: 3, now: () => now });
    for (let i = 0; i < 5; i++) await s.turn(`${FACT} number ${i}`);
    expect(s.provider.requests).toHaveLength(3);
    expect(s.warnings.filter((w) => w.includes("daily cap"))).toHaveLength(1);
    now = day(1);
    await s.turn(FACT);
    expect(s.provider.requests).toHaveLength(4);
  });

  it("is persisted: a restart on the same database does not reset it", async () => {
    const db = openDb(":memory:");
    const first = setup({ db, dailyCap: 2 });
    await first.turn(FACT);
    await first.turn(FACT);
    const second = setup({ db, dailyCap: 2 });
    await second.turn(FACT);
    expect(second.provider.requests).toHaveLength(0);
    expect(first.provider.requests).toHaveLength(2);
    expect(second.profile.status()).toMatchObject({ usedToday: 2, cap: 2 });
  });

  it("counts the owner's local day, not UTC", async () => {
    // 23:30 on the 25th in UTC is already the 26th in Tokyo.
    const db = openDb(":memory:");
    const at = Date.UTC(2026, 10, 25, 23, 30);
    const profile = createUserProfile({
      db,
      home: "/nonexistent",
      memory: {} as never,
      provider: new FakeModelProvider({ id: "fake" }),
      model: "x/y",
      active: true,
      now: () => at,
      timeZone: () => "Asia/Tokyo",
      redactor: new SecretRedactor() as never,
      audit: { append: async () => undefined } as never,
      broker: {} as never,
      surfaces: ["desktop"],
      publish: () => undefined,
    });
    const id = db.newId();
    createThread(db, { id, kind: "side", sessionKey: `k:${id}` } as never);
    await profile.onOwnerTurn({ threadId: id, runId: "r1", ownerText: FACT });
    const { getSetting } = await import("@psyche/db");
    expect(getSetting(db, LEARNER_USAGE_SETTING)?.value).toEqual({ day: "2026-11-26", count: 1 });
  });
});
