import { afterEach, describe, expect, it } from "vitest";
import { searchTerms } from "../src/index-db.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

async function seeded() {
  env = await makeEnv();
  // Boilerplate that is full of stop words, like the real SOUL.md and AGENTS.md.
  await env.store.writeFileAsOwner(
    "SOUL.md",
    "# Soul\n\nWhat I do is keep things short. When it is unclear, I ask.\n",
  );
  await env.store.writeFileAsOwner(
    "AGENTS.md",
    "# Operating instructions\n\nWhat is asked is done. Do not act when it is unsafe.\n",
  );
  await env.store.appendDailyNote({ text: "Standup is at 10:30 on weekdays", provenance: "owner" });
  await env.store.appendDailyNote({ text: "The owner drives a red Subaru", provenance: "owner" });
  return env.store;
}

describe("memory search ignores stop words (QA item 16)", () => {
  it("'when is standup' finds the note and not the persona files", async () => {
    const store = await seeded();
    const hits = await store.search("when is standup");
    expect(hits.map((h) => h.chunk.source)).toEqual([expect.stringMatching(/^memory\//)]);
    expect(hits[0]?.chunk.text).toContain("Standup");
  });

  it("'what car do I drive' does not surface SOUL.md or AGENTS.md", async () => {
    const store = await seeded();
    const sources = (await store.search("what car do I drive")).map((h) => h.chunk.source);
    expect(sources).not.toContain("SOUL.md");
    expect(sources).not.toContain("AGENTS.md");
  });

  it("a query of only stop words or one letter returns nothing", async () => {
    const store = await seeded();
    expect(await store.search("what is it")).toEqual([]);
    expect(await store.search("i")).toEqual([]);
  });

  it("control: a real match in a system file is still found", async () => {
    const store = await seeded();
    const hits = await store.search("keep things short");
    expect(hits.map((h) => h.chunk.source)).toContain("SOUL.md");
    // A stop word inside a longer query does not hide the real term.
    const mixed = await store.search("what do I keep short");
    expect(mixed.map((h) => h.chunk.source)).toContain("SOUL.md");
  });

  it("name-like words and one-letter names still find their notes", async () => {
    const store = await seeded();
    await store.appendDailyNote({ text: "Will signed the lease", provenance: "owner" });
    await store.appendDailyNote({
      text: "C is the language for the firmware",
      provenance: "owner",
    });
    expect((await store.search("Will")).map((h) => h.chunk.text).join("\n")).toContain(
      "Will signed",
    );
    expect((await store.search("C")).map((h) => h.chunk.text).join("\n")).toContain("firmware");
    expect(searchTerms("Will")).toEqual(["will"]);
    expect(searchTerms("C")).toEqual(["c"]);
  });

  it("'is it' matches nothing by keyword", async () => {
    const store = await seeded();
    expect(searchTerms("is it")).toEqual([]);
    expect(await store.search("is it")).toEqual([]);
  });

  it("searchTerms keeps non-Latin and numeric terms", () => {
    expect(searchTerms("what is 李明 at 10")).toEqual(["李明", "10"]);
    expect(searchTerms("is it the")).toEqual([]);
  });
});
