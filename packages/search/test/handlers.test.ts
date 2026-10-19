import { validateResult } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { createSearchHandlers } from "../src/handlers.ts";
import { doc, setup } from "./helpers.ts";

describe("search.query handler", () => {
  it("returns wire hits with scopes and deep-link routes", async () => {
    const { index } = setup();
    await index.indexMany([
      doc({ id: "T1", kind: "thread", threadId: "T1", title: "Dentist", text: "Dentist" }),
      doc({ id: "m1", kind: "message", threadId: "T2", title: "Other", text: "dentist bill" }),
      doc({ id: "K1", kind: "task", title: "Book dentist", text: "dentist" }),
      doc({ id: "G1", kind: "goal", title: "Dentist twice a year", text: "dentist" }),
    ]);
    const h = createSearchHandlers(index);
    const res = await h["search.query"]({ query: "dentist" });
    expect(validateResult("search.query", res)).toBe(res);
    expect(res.hits.map((x) => [x.scope, x.route]).sort()).toEqual(
      [
        ["messages", "/chat/T2?message=m1"],
        ["tasks", "/agent/activity/K1"],
        ["threads", "/chat/T1"],
      ].sort(),
    );
    const onlyTasks = await h["search.query"]({ query: "dentist", scopes: ["tasks"] });
    expect(onlyTasks.hits.map((x) => x.id)).toEqual(["K1"]);
    const threads = await h["search.query"]({ query: "dentist", scopes: ["threads"] });
    expect(threads.hits.map((x) => x.id).sort()).toEqual(["T1", "m1"]);
    const messages = await h["search.query"]({ query: "dentist", scopes: ["messages"] });
    expect(messages.hits.map((x) => x.id)).toEqual(["m1"]);
  });

  it("maps scopes to kinds before ranking (review fixes)", async () => {
    const { index } = setup();
    await index.indexMany([
      doc({
        id: "T1",
        kind: "thread",
        threadId: "T1",
        title: "Dentist dentist",
        text: "Dentist dentist dentist",
      }),
      doc({ id: "m1", kind: "message", threadId: "T1", title: "Dentist", text: "dentist at nine" }),
      doc({ id: "m2", kind: "message", threadId: "T1", title: "Dentist", text: "dentist moved" }),
      doc({ id: "K1", kind: "task", title: "Book dentist", text: "dentist" }),
      ...Array.from({ length: 5 }, (_, i) =>
        doc({
          id: `I${i}`,
          kind: "idea",
          title: "Dentist dentist",
          text: "dentist dentist dentist",
        }),
      ),
    ]);
    const h = createSearchHandlers(index);
    const mt = await h["search.query"]({ query: "dentist", scopes: ["messages", "tasks"] });
    expect(mt.hits.map((x) => x.id).sort()).toEqual(["K1", "m1", "m2"]);
    const m = await h["search.query"]({ query: "dentist", scopes: ["messages"] });
    expect(m.hits.map((x) => x.id).sort()).toEqual(["m1", "m2"]);
    const limited = await h["search.query"]({ query: "dentist", limit: 2 });
    expect(limited.hits).toHaveLength(2);
    expect(limited.hits.every((x) => !x.id.startsWith("I"))).toBe(true);
  });

  it("applies the caller's viewer scope", async () => {
    const { index } = setup();
    await index.index(doc({ id: "a", text: "secret", scopeKey: "owner" }));
    const h = createSearchHandlers(index);
    const res = await h["search.query"](
      { query: "secret" },
      { viewer: { kind: "delegated", scopeKey: "telegram:peer:1" } },
    );
    expect(res.hits).toEqual([]);
  });
});
