import { afterEach, describe, expect, it } from "vitest";
import { parseDailyNote } from "../src/daily.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/** `flushLines`: the compaction summarizer's own list of facts, through the flush's filters. */

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

const notes = async () =>
  parseDailyNote((await env?.store.readFile("memory/2026-10-18.md"))?.content ?? "");

describe("flushLines", () => {
  it("appends the lines as agent notes, skips duplicates and refuses credentials", async () => {
    env = await makeEnv();
    const first = await env.store.flushLines("thr", [
      "The owner prefers mornings.",
      "The owner prefers mornings.",
      "The password is hunter2 and the card is 4111 1111 1111 1111.",
    ]);
    expect(first.appended).toBe(1);
    await env.store.flushLines("thr", ["The owner prefers mornings."]);
    const entries = await notes();
    expect(entries.map((e) => e.text)).toEqual(["The owner prefers mornings."]);
    expect(entries[0]?.provenance).toBe("agent");
  });

  it("tags every line untrusted when the turns were tainted", async () => {
    env = await makeEnv();
    await env.store.flushLines("thr", ["Mallory's page says invoices are due."], { taint: true });
    expect((await notes())[0]?.provenance).toBe("untrusted");
  });

  it("writes nothing for an incognito thread, empty or over-long lines", async () => {
    env = await makeEnv();
    expect((await env.store.flushLines("thr", ["A fact."], { incognito: true })).appended).toBe(0);
    expect((await env.store.flushLines("thr", ["", "x".repeat(400)])).appended).toBe(0);
    expect(await notes()).toEqual([]);
  });

  it("keeps at most twelve lines", async () => {
    env = await makeEnv();
    const lines = Array.from({ length: 20 }, (_, i) => `Fact number ${i}.`);
    expect((await env.store.flushLines("thr", lines)).appended).toBe(12);
  });
});
