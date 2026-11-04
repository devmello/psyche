import {
  APPLE_LLM_CONTEXT_TOKENS,
  APPLE_ON_DEVICE_REF,
  EVERYTHING_MEMORY_DEFAULTS,
  type EverythingMemorySettings,
  type ModelEvent,
} from "@psyche/protocol";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkGates,
  groupBatches,
  MAX_ITEMS_PER_BATCH,
  type ModelChoice,
  modelKindsInUse,
  type PassDeps,
  runEverythingPass,
  SearchDocReader,
  type SystemState,
  skipReasonFor,
  windowItemTokens,
  windowPlan,
} from "../src/extraction/index.ts";
import { EverythingStore } from "../src/graph/everything.ts";
import { GraphStore } from "../src/graph/store.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * EM11 with Apple's on-device model, against fakes only: nothing here starts the real model or the
 * Mac helper. The fake "apple" provider is a `FakeModelProvider`; refusals are the same
 * `finish{error}` events the router adapter produces.
 */

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-29T03:00:00Z");
const NIGHT: SystemState = { onAc: true, lowPowerMode: false, thermal: "nominal", idleMinutes: 60 };
const APPLE = { kind: "local", ref: APPLE_ON_DEVICE_REF } as const;

function settingsWith(
  model: EverythingMemorySettings["model"],
  sources: Partial<EverythingMemorySettings["sources"]> = { mail: true },
): EverythingMemorySettings {
  const base = structuredClone(EVERYTHING_MEMORY_DEFAULTS) as EverythingMemorySettings;
  return { ...base, enabled: true, sources: { ...base.sources, ...sources }, model };
}

describe("the window plan", () => {
  it("leaves room in the 4,096-token window for the prompt, the framing and the answer", () => {
    const plan = windowPlan({ contextTokens: APPLE_LLM_CONTEXT_TOKENS });
    expect(plan.maxBatchTokens).toBeGreaterThan(500);
    // Prompt and answer both fit: system (~900 careful tokens) + frame + output + items <= window.
    expect(plan.maxBatchTokens + plan.maxOutputTokens + 200).toBeLessThan(APPLE_LLM_CONTEXT_TOKENS);
    // Never more characters than the helper takes in one prompt field.
    expect(plan.maxBatchTokens * 3).toBeLessThanOrEqual(plan.maxPromptChars);
  });

  it("a smaller window gives a smaller budget, and a tiny one gives none", () => {
    expect(windowPlan({ contextTokens: 3000 }).maxBatchTokens).toBeLessThan(
      windowPlan({ contextTokens: 4096 }).maxBatchTokens,
    );
    expect(windowPlan({ contextTokens: 500 }).maxBatchTokens).toBe(0);
  });

  it("counts text on the careful scale and maps refusals to recorded reasons", () => {
    expect(windowItemTokens("x".repeat(300))).toBe(130);
    expect(skipReasonFor("model_not_found")).toBe("model_unavailable");
    expect(skipReasonFor("content_filter")).toBe("model_guardrail");
    expect(skipReasonFor("context_overflow")).toBe("model_too_long");
    expect(skipReasonFor("timeout")).toBe("model_failed");
    expect(skipReasonFor(undefined)).toBe("model_failed");
  });

  it("groups items so no batch is over the budget, and never more than eight items", () => {
    const plan = windowPlan({ contextTokens: APPLE_LLM_CONTEXT_TOKENS });
    const mk = (i: number, chars: number) => ({
      item: { handle: "", sourceRef: `m${i}` } as never,
      mentions: [],
      group: "owner:t",
      tokens: windowItemTokens("x".repeat(chars)),
    });
    const items = [
      ...Array.from({ length: 5 }, (_, i) => mk(i, 1500)),
      ...Array.from({ length: 12 }, (_, i) => mk(i + 5, 40)),
    ];
    const batches = groupBatches(items, {
      maxItems: MAX_ITEMS_PER_BATCH,
      maxTokens: plan.maxBatchTokens,
    });
    expect(batches.flat()).toHaveLength(items.length);
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(MAX_ITEMS_PER_BATCH);
      expect(b.reduce((n, p) => n + p.tokens, 0)).toBeLessThanOrEqual(plan.maxBatchTokens);
    }
    // The default (cloud) limits would have fit those five long items in one call.
    expect(groupBatches(items.slice(0, 5)).length).toBe(1);
    expect(
      groupBatches(items.slice(0, 5), { maxItems: 8, maxTokens: plan.maxBatchTokens }).length,
    ).toBeGreaterThan(1);
  });
});

describe("gates", () => {
  it("Apple's model needs no RAM confirmation and is not counted as a local model", () => {
    const s = settingsWith({ default: { kind: "none" }, perSource: { mail: APPLE } });
    expect([...modelKindsInUse(s)]).toEqual(["apple"]);
    expect(
      checkGates({ settings: s, state: NIGHT, localMinutes: 3 * 60, localModelConfirmed: false }),
    ).toEqual({ ok: true });
    const ollama = settingsWith({
      default: { kind: "none" },
      perSource: { mail: { kind: "local", ref: "ollama/qwen3:4b" } },
    });
    expect(
      checkGates({
        settings: ollama,
        state: NIGHT,
        localMinutes: 3 * 60,
        localModelConfirmed: false,
      }),
    ).toEqual({ ok: false, reason: "local_not_confirmed" });
  });
});

let env: TestEnv;
let search: Database.Database;
let graph: GraphStore;
let em: EverythingStore;
let clock: FakeClock;
let apple: FakeModelProvider;
let cloud: FakeModelProvider;
let seq = 0;

const DDL = `CREATE TABLE search_docs (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, grp TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, extra TEXT NOT NULL, provenance TEXT NOT NULL, thread_id TEXT, parent_id TEXT,
  collapse_key TEXT NOT NULL, scope_key TEXT NOT NULL, sender TEXT, sender_key TEXT, mime TEXT, tags TEXT NOT NULL,
  source TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`;

function doc(body: string, source = "connector:mail", thread = "t1") {
  const id = `d:${++seq}`;
  const ms = NOW - DAY / 2 + seq;
  search
    .prepare(
      `INSERT INTO search_docs (id, kind, grp, title, body, extra, provenance, thread_id, collapse_key, scope_key, tags, source, created_ms, updated_ms)
       VALUES (?, 'connector', 'connectors', '', ?, '', 'owner', ?, ?, 'owner', '[]', ?, ?, ?)`,
    )
    .run(id, body, thread, id, source, ms, ms);
  return id;
}

const EMPTY: ModelEvent[] = [
  { type: "text_delta", text: '{"facts":[],"edges":[],"flags":[]}' },
  { type: "finish", reason: "stop" },
];
const refuse = (kind: string): ModelEvent[] => [
  { type: "finish", reason: "error", error: `${kind}: refused` },
];

const sentChars = (p: FakeModelProvider) =>
  p.requests.map((r) =>
    r.messages.reduce(
      (n, m) =>
        n + m.parts.reduce((k, part) => k + (part.type === "text" ? part.text.length : 0), 0),
      (r.system ?? "").length,
    ),
  );

function deps(settings: EverythingMemorySettings, over: Partial<PassDeps> = {}): PassDeps {
  const choices: Record<string, ModelChoice> = {
    apple: { provider: apple, model: APPLE_ON_DEVICE_REF, window: { contextTokens: 4096 } },
    cloud: { provider: cloud, model: "fake/haiku" },
  };
  return {
    graph,
    em,
    sqlite: env.db.sqlite,
    reader: new SearchDocReader(search),
    settings,
    state: NIGHT,
    clock,
    timeZone: "UTC",
    localMinutes: 3 * 60,
    // What the Gateway does: a local choice naming Apple's ref is the windowed Apple model.
    modelFor: (kind, source) => {
      const per = (settings.model.perSource as Record<string, { kind: string; ref?: string }>)?.[
        source
      ];
      const choice = per ?? settings.model.default;
      if (kind === "local" && choice.ref === APPLE_ON_DEVICE_REF) return choices.apple;
      return kind === "cloud" ? choices.cloud : undefined;
    },
    ...over,
  };
}

beforeEach(async () => {
  clock = new FakeClock(NOW);
  env = await makeEnv({ clock });
  graph = new GraphStore({ sqlite: env.db.sqlite, clock });
  em = new EverythingStore({ sqlite: env.db.sqlite, graph, clock });
  graph.createEntity({ kind: "person", name: "The Owner", isOwner: true });
  search = new Database(":memory:");
  search.exec(DDL);
  apple = new FakeModelProvider({ id: "apple" });
  cloud = new FakeModelProvider({ id: "cloud" });
  seq = 0;
});
afterEach(async () => {
  search.close();
  await env.cleanup();
});

describe("per-source routing", () => {
  it("only the chosen source goes to Apple; the others use the default model", async () => {
    doc("Note to self: book the dentist for Friday morning.", "connector:mail");
    doc("Note to self: call the plumber on Monday afternoon.", "connector:imessage", "t2");
    apple.enqueue(EMPTY);
    cloud.enqueue(EMPTY);
    const r = await runEverythingPass(
      deps(
        settingsWith(
          { default: { kind: "cloud", ref: "fake/haiku" }, perSource: { messages: APPLE } },
          { mail: true, messages: true },
        ),
      ),
    );
    expect(r.ran).toBe(true);
    expect(apple.requests).toHaveLength(1);
    expect(cloud.requests).toHaveLength(1);
    expect(apple.requests[0]?.model).toBe(APPLE_ON_DEVICE_REF);
    expect(JSON.stringify(apple.requests[0])).toMatch(/plumber/);
    expect(JSON.stringify(apple.requests[0])).not.toMatch(/dentist/);
    expect(JSON.stringify(cloud.requests[0])).not.toMatch(/plumber/);
    expect(apple.requests[0]?.tools).toEqual([]);
    // The answer is capped to leave room in the window.
    expect(apple.requests[0]?.maxOutputTokens).toBeLessThan(1024);
  });

  it("with no per-source choice, Apple is never used", async () => {
    doc("Note to self: book the dentist for Friday morning.");
    cloud.enqueue(EMPTY);
    await runEverythingPass(deps(settingsWith({ default: { kind: "cloud", ref: "fake/haiku" } })));
    expect(apple.requests).toHaveLength(0);
    expect(cloud.requests).toHaveLength(1);
  });
});

describe("batches under the window", () => {
  it("splits many long items into calls that each fit", async () => {
    const plan = windowPlan({ contextTokens: 4096 });
    for (let i = 0; i < 6; i++)
      doc(`Note to self: ${"plan the trip and pack. ".repeat(60)} (${i})`);
    for (let i = 0; i < 8; i++) apple.enqueue(EMPTY);
    const r = await runEverythingPass(deps(settingsWith({ default: APPLE })));
    expect(r.error).toBeNull();
    expect(r.batches).toBeGreaterThan(1);
    expect(r.dropped.item_too_long_for_window).toBeUndefined();
    for (const n of sentChars(apple)) {
      // The estimate counts three characters a token; every call is under the window with room
      // for the answer.
      expect(n / 3 + plan.maxOutputTokens).toBeLessThan(4096);
      expect(n).toBeLessThanOrEqual(2 * 9000);
    }
    expect(cloud.requests).toHaveLength(0);
  });
});

describe("an item too long for the window", () => {
  it("is skipped with a reason, never cut and never sent elsewhere", async () => {
    doc(`Note to self: ${"a very long rambling note. ".repeat(500)}`);
    doc("Note to self: book the dentist for Friday morning.", "connector:mail", "t9");
    apple.enqueue(EMPTY);
    // A smaller window than the real one, so the (6,000 character) cap on an item no longer fits.
    const small: Partial<PassDeps> = {
      modelFor: () => ({
        provider: apple,
        model: APPLE_ON_DEVICE_REF,
        window: { contextTokens: 2600 },
      }),
    };
    const r = await runEverythingPass(deps(settingsWith({ default: APPLE }), small));
    expect(r.dropped.item_too_long_for_window).toBe(1);
    expect(apple.requests).toHaveLength(1);
    expect(JSON.stringify(apple.requests[0])).toMatch(/dentist/);
    expect(JSON.stringify(apple.requests[0])).not.toMatch(/rambling/);
    expect(cloud.requests).toHaveLength(0);
  });
});

describe("no cloud fallback", () => {
  const cases: [string, string][] = [
    ["model_not_found", "model_unavailable"],
    ["content_filter", "model_guardrail"],
    ["context_overflow", "model_too_long"],
    ["timeout", "model_failed"],
  ];
  it.each(cases)(
    "a %s refusal does nothing for the batch, records why, and asks no one else",
    async (kind, why) => {
      doc("Note to self: book the dentist for Friday morning.");
      apple.enqueue(refuse(kind), refuse(kind), refuse(kind));
      const r = await runEverythingPass(
        deps(
          settingsWith({
            default: { kind: "cloud", ref: "fake/haiku" },
            perSource: { mail: APPLE },
          }),
        ),
      );
      expect(r.ran).toBe(true);
      expect(r.factsStored).toBe(0);
      expect(r.dropped[why]).toBe(1);
      // One try, no retry on the same model, nothing to the cloud model that is the default.
      expect(apple.requests).toHaveLength(1);
      expect(cloud.requests).toHaveLength(0);
      expect(r.quarantined).toBe(0);
    },
  );

  it("an unavailable model keeps the cursor, so tomorrow reads the same items", async () => {
    doc("Note to self: book the dentist for Friday morning.");
    const settings = settingsWith({ default: APPLE });
    apple.enqueue(refuse("model_not_found"));
    const first = await runEverythingPass(deps(settings));
    expect(first.deferred).toBe(1);
    expect(graph.cursor("everything:mail")).toBeFalsy();
    apple.enqueue(EMPTY);
    const second = await runEverythingPass(deps(settings));
    expect(second.batches).toBe(1);
    expect(apple.requests).toHaveLength(2);
    expect(cloud.requests).toHaveLength(0);
  });
});
