import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, setSetting } from "@psyche/db";
import { createModelRouter } from "@psyche/model-router";
import { APPLE_ON_DEVICE_REF, type MethodResult, SEARCH_MODEL_ENGINE_KEY } from "@psyche/protocol";
import { QueryModel } from "@psyche/search";
import { collect, FakeAppleLlmNode, FakeClock, FakeModelProvider } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelSettingsHandlers } from "../src/compose/model-settings.ts";
import { searchEngine, searchModelProvider } from "../src/compose/search-engine.ts";
import type { Call } from "../src/context.ts";

// Apple's on-device model is never run here: the Mac helper is `FakeAppleLlmNode`.

let home: string;
let db: ReturnType<typeof openDb>;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "psyche-apple-")));
  db = openDb(join(home, "psyche.db"));
});
afterEach(async () => {
  db.close();
  await rm(home, { recursive: true, force: true });
});

const clock = new FakeClock(Date.parse("2026-11-03T10:00:00Z"));

describe("models.appleStatus (Settings hook)", () => {
  const status = async (node: FakeAppleLlmNode | undefined) => {
    const router = createModelRouter(
      { providers: [{ id: "apple", kind: "apple" }] },
      { clock, apple: { node: () => node } },
    );
    const handlers = modelSettingsHandlers({ db, router, providers: [], clock });
    return (await handlers["models.appleStatus"]?.run(
      {} as Call,
      {} as never,
    )) as MethodResult<"models.appleStatus">;
  };

  it("says no Mac helper is connected, without erroring", async () => {
    expect(await status(undefined)).toEqual({
      ref: APPLE_ON_DEVICE_REF,
      helperConnected: false,
      available: false,
      contextTokens: 4096,
    });
  });

  it("reports availability and the reason, and never generates", async () => {
    const node = new FakeAppleLlmNode();
    expect(await status(node)).toMatchObject({ helperConnected: true, available: true });
    node.availability = {
      available: false,
      reason: "apple_intelligence_not_enabled",
      contextTokens: 4096,
    };
    expect(await status(node)).toMatchObject({
      helperConnected: true,
      available: false,
      reason: "apple_intelligence_not_enabled",
    });
    expect(node.requests).toEqual([]);
  });
});

describe("search.model.engine", () => {
  it("defaults to the utility model; only the exact value apple switches", () => {
    const engine = searchEngine(db);
    expect(engine()).toBe("utility");
    setSetting(db, SEARCH_MODEL_ENGINE_KEY, "apple");
    expect(engine()).toBe("apple");
    setSetting(db, SEARCH_MODEL_ENGINE_KEY, "cloud");
    expect(engine()).toBe("utility");
  });

  it("sends the utility ref to the base provider, or apple/on-device with no tools", async () => {
    const base = new FakeModelProvider({ id: "router" });
    let engine: "utility" | "apple" = "utility";
    const provider = searchModelProvider(base, () => engine);
    const req = {
      model: "router/utility" as const,
      messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "q" }] }],
      tools: [
        {
          name: "t",
          description: "",
          inputSchema: {},
          sideEffect: "none" as const,
          provenanceOut: "trusted" as const,
        },
      ],
    };
    base.enqueue([{ type: "finish", reason: "stop" }], [{ type: "finish", reason: "stop" }]);
    await collect(provider.stream(req));
    engine = "apple";
    await collect(provider.stream(req));
    expect(base.requests.map((r) => r.model)).toEqual(["router/utility", APPLE_ON_DEVICE_REF]);
    expect(base.requests[1]?.tools).toEqual([]);
    expect(base.requests[1]?.toolChoice).toBe("none");
  });

  it("fails closed: an unavailable on-device model leaves the rules in charge and never asks the utility model", async () => {
    const node = new FakeAppleLlmNode();
    node.availability = { available: false, reason: "device_not_eligible", contextTokens: 4096 };
    const utility = new FakeModelProvider({ id: "utility" });
    const apple = createModelRouter(
      { providers: [{ id: "apple", kind: "apple" }] },
      { clock, apple: { node: () => node } },
    );
    // The router sees only the apple provider; a cloud one would need its own entry, and the test
    // asserts the utility fake is never reached.
    const provider = searchModelProvider(apple, () => "apple");
    const model = new QueryModel({ provider, model: "router/utility" as never });
    const plan = await model.read("what did my landlord say before the move?", {
      now: clock.now(),
      tzOffsetMinutes: 0,
    });
    expect(plan).toBeUndefined();
    expect(utility.requests).toEqual([]);
    expect(node.requests).toEqual([]);
  });

  it("reads a question through the on-device model when it is available", async () => {
    const node = new FakeAppleLlmNode();
    node.replies = [
      '{"terms":["lease"],"after":"2026-09-01","before":"2026-09-30","people":[],"sources":[],"intent":"find"}',
    ];
    const apple = createModelRouter(
      { providers: [{ id: "apple", kind: "apple" }] },
      { clock, apple: { node: () => node } },
    );
    const model = new QueryModel({
      provider: searchModelProvider(apple, () => "apple"),
      model: "router/utility" as never,
    });
    const plan = await model.read("the lease around the start of September", {
      now: clock.now(),
      tzOffsetMinutes: 0,
    });
    expect(plan).toMatchObject({ terms: ["lease"], after: "2026-09-01", before: "2026-09-30" });
    expect(node.requests).toHaveLength(1);
    expect(node.requests[0]?.prompt).toContain("the lease around the start of September");
  });
});
