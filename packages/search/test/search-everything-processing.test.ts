import { describe, expect, it } from "vitest";
import { searchEverything } from "../src/agent/search-everything.ts";
import { sourceTag } from "../src/index.ts";
import { doc, setup } from "./helpers.ts";

/**
 * Processing is enforced where text leaves the Mac: a source set to `none` or `local` is never
 * shown to a cloud model, in the tool's output or in the synthesis prompt.
 */

async function seeded() {
  const { index } = setup();
  await index.indexMany([
    doc({
      id: "notes-1",
      kind: "connector",
      source: sourceTag("notes"),
      title: "Lease notes",
      provenance: "owner",
      text: "Harbor district lease starts in March, rent is paid on the first.",
    }),
    doc({
      id: "contacts-1",
      kind: "connector",
      source: sourceTag("contacts"),
      title: "Jordan Rivera",
      provenance: "untrusted",
      text: "Jordan Rivera, landlord of the harbor district lease, phone +1 510 555 0101.",
    }),
    doc({
      id: "contacts-2",
      kind: "connector",
      source: sourceTag("contacts"),
      title: "Sam Lee",
      provenance: "untrusted",
      text: "Sam Lee, harbor district lease co-signer, phone +1 510 555 0102.",
    }),
  ]);
  return index;
}

const ctx = { threadId: "t1" };
const blocked = () => [sourceTag("contacts")];

describe("search_everything and processing", () => {
  it("find: a cloud reader gets no hit from a source that keeps its text on this Mac, and is told", async () => {
    const index = await seeded();
    const { output } = await searchEverything(
      { index, cloudBlocked: blocked, outputIsCloud: () => true },
      { query: "harbor district lease" },
      ctx,
    );
    expect(output.hits.map((h) => h.id)).toEqual(["notes-1"]);
    expect(JSON.stringify(output)).not.toContain("555 0101");
    expect(output.withheld).toEqual([{ source: "contacts", count: 2 }]);
    expect(output.withheldNote).toContain("2 results from contacts not sent off this Mac");
  });

  it("find: a local reader gets everything the agent may search", async () => {
    const index = await seeded();
    const { output } = await searchEverything(
      { index, cloudBlocked: blocked, outputIsCloud: () => false, synthesisIsCloud: () => false },
      { query: "harbor district lease" },
      ctx,
    );
    expect(output.hits.map((h) => h.id).sort()).toEqual(["contacts-1", "contacts-2", "notes-1"]);
    expect(output.withheld).toBeUndefined();
  });

  it("answer: a cloud synthesis model is sent only the sources that may go to it", async () => {
    const index = await seeded();
    const prompts: string[] = [];
    const { output } = await searchEverything(
      {
        index,
        cloudBlocked: blocked,
        outputIsCloud: () => false,
        synthesisIsCloud: () => true,
        async complete(_system, user) {
          prompts.push(user);
          return JSON.stringify({
            sentences: [{ text: "The lease starts in March.", cites: ["notes-1"] }],
          });
        },
      },
      { query: "harbor district lease", mode: "answer" },
      ctx,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Lease notes");
    expect(prompts[0]).not.toContain("555 0101");
    expect(prompts[0]).not.toContain("Jordan Rivera");
    expect(output.answer?.sources).toEqual(["notes-1"]);
    expect(output.withheld).toEqual([{ source: "contacts", count: 2 }]);
  });

  it("answer: with only withheld sources the model is not called", async () => {
    const index = await seeded();
    let called = 0;
    const { output } = await searchEverything(
      {
        index,
        cloudBlocked: blocked,
        async complete() {
          called += 1;
          return "{}";
        },
      },
      { query: "landlord phone", mode: "answer", sources: [sourceTag("contacts")] },
      ctx,
    );
    expect(called).toBe(0);
    expect(output.answerNote).toBe("withheld");
    expect(output.hits).toEqual([]);
  });

  it("answer: a local synthesis model feeding a cloud reader still leaves the source out of the answer", async () => {
    const index = await seeded();
    const prompts: string[] = [];
    await searchEverything(
      {
        index,
        cloudBlocked: blocked,
        outputIsCloud: () => true,
        synthesisIsCloud: () => false,
        async complete(_s, user) {
          prompts.push(user);
          return JSON.stringify({ sentences: [] });
        },
      },
      { query: "harbor district lease", mode: "answer" },
      ctx,
    );
    expect(prompts[0]).not.toContain("Jordan Rivera");
  });

  it("a source set to cloud is unaffected, and so is a search with nothing blocked", async () => {
    const index = await seeded();
    const { output } = await searchEverything(
      { index, cloudBlocked: () => [], outputIsCloud: () => true },
      { query: "harbor district lease" },
      ctx,
    );
    expect(output.hits).toHaveLength(3);
    expect(output.withheld).toBeUndefined();
  });
});
