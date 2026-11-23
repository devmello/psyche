import { validateParams } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { createSearchHandlers } from "../src/handlers.ts";
import { doc, setup } from "./helpers.ts";

describe("search.query from (sender filter)", () => {
  const fixtures = async () => {
    const { index } = setup();
    await index.indexMany([
      doc({
        id: "mail1",
        kind: "connector",
        title: "Invoice",
        text: "invoice for May",
        from: "Alice Chen <alice@example.com>",
      }),
      doc({
        id: "mail2",
        kind: "connector",
        title: "Invoice two",
        text: "invoice",
        from: "alice_b",
      }),
      doc({ id: "mail3", kind: "connector", title: "Invoice three", text: "invoice", from: "axb" }),
      doc({ id: "chat1", kind: "message", threadId: "T9", text: "invoice, no sender" }),
      doc({ id: "task1", kind: "task", title: "Invoice task", text: "invoice" }),
    ]);
    return createSearchHandlers(index);
  };
  const ids = async (h: Awaited<ReturnType<typeof fixtures>>, from?: string) =>
    (
      await h["search.query"]({
        query: "invoice",
        limit: 50,
        ...(from === undefined ? {} : { from }),
      })
    ).hits
      .map((x) => x.id)
      .sort();

  it("is optional: without it every scope still matches", async () => {
    const h = await fixtures();
    expect(await ids(h)).toEqual(["chat1", "mail1", "mail2", "mail3", "task1"]);
  });

  it("keeps only documents whose sender matches, case-insensitively", async () => {
    const h = await fixtures();
    expect(await ids(h, "ALICE")).toEqual(["mail1", "mail2"]);
    expect(await ids(h, "alice@example.com")).toEqual(["mail1"]);
    expect(await ids(h, "chen")).toEqual(["mail1"]);
  });

  it("drops scopes with no sender (chat messages, tasks) when set", async () => {
    const h = await fixtures();
    expect(await ids(h, "axb")).toEqual(["mail3"]);
    expect(await ids(h, "nobody-here")).toEqual([]);
    expect(await ids(h, "T9")).toEqual([]);
  });

  it("matches % and _ and quotes in the name literally, never as wildcards", async () => {
    const h = await fixtures();
    // `_` is a wildcard in LIKE; here it matches only a real underscore.
    expect(await ids(h, "alice_b")).toEqual(["mail2"]);
    expect(await ids(h, "a_b")).toEqual([]);
    expect(await ids(h, "%")).toEqual([]);
    expect(await ids(h, "_")).toEqual(["mail2"]);
    expect(await ids(h, `x" OR 1=1 --`)).toEqual([]);
    expect(await ids(h, "'; DROP TABLE search_docs; --")).toEqual([]);
  });

  it("validates the param: a blank name is refused, a name is accepted", () => {
    expect(validateParams("search.query", { query: "x", from: "alice" })).toEqual({
      query: "x",
      from: "alice",
    });
    expect(() => validateParams("search.query", { query: "x", from: "" })).toThrow();
  });
});
