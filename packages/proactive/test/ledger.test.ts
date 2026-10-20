import { describe, expect, it } from "vitest";
import {
  applyFeedback,
  exclusions,
  hiddenHosts,
  keyPhrase,
  ledgerTopics,
  parseLedger,
  serializeLedger,
} from "../src/index.ts";
import { INTERESTS } from "./fixtures/feeds.ts";

const ctx = (over: Partial<Parameters<typeof applyFeedback>[2]> = {}) => ({
  topics: ["robotics manipulation"],
  hosts: ["gossip.example"],
  title: "New gripper learns from ten demos",
  ref: "post p1",
  date: "2026-10-19",
  ...over,
});

describe("interest ledger", () => {
  it("parses topics, exclusions and hidden hosts; examples in the comment are not entries", () => {
    const ledger = parseLedger(`${INTERESTS}- !hide-source: gossip.example — hidden\n`);
    expect(ledgerTopics(ledger).map((t) => [t.topic, t.weight])).toEqual([
      ["robotics manipulation", 0.9],
      ["UCSC events", 0.6],
    ]);
    expect(exclusions(ledger)).toEqual(["celebrity news"]);
    expect(hiddenHosts(ledger)).toEqual(["gossip.example"]);
  });

  it("round-trips without touching the owner's prose", () => {
    const text = `${INTERESTS}\nSome prose the owner wrote.\n- a malformed line (two) — kept as is\n`;
    expect(serializeLedger(parseLedger(text))).toBe(text);
  });

  it("applies the feedback rules and undoes them", () => {
    const ledger = parseLedger(INTERESTS);
    expect(applyFeedback(ledger, "like", ctx())).toEqual([
      "- robotics manipulation (1.00) — asked 6 times in September; saved 3 arXiv papers; like 2026-10-19 (post p1)",
    ]);
    applyFeedback(ledger, "like", ctx(), { undo: true });
    expect(ledgerTopics(ledger)[0]?.weight).toBe(0.9);
    applyFeedback(ledger, "save", ctx());
    expect(ledgerTopics(ledger)[0]?.weight).toBe(1);
    applyFeedback(ledger, "save", ctx(), { undo: true });
    expect(ledgerTopics(ledger)[0]?.weight).toBe(0.85);
    expect(applyFeedback(ledger, "hide_source", ctx())).toEqual([
      "- !hide-source: gossip.example — hidden 2026-10-19 (post p1)",
    ]);
    expect(applyFeedback(ledger, "hide_source", ctx())).toEqual([]);
    expect(applyFeedback(ledger, "hide_source", ctx(), { undo: true })[0]).toMatch(/^removed: /);
    expect(hiddenHosts(ledger)).toEqual([]);
    expect(applyFeedback(ledger, "follow_topic", ctx({ topic: "sourdough" }))).toEqual([
      "- sourdough (0.60) — followed 2026-10-19 (post p1)",
    ]);
    applyFeedback(ledger, "follow_topic", ctx({ topic: "Sourdough" }));
    expect(ledgerTopics(ledger).find((t) => t.topic === "sourdough")?.weight).toBe(0.8);
    applyFeedback(ledger, "follow_topic", ctx({ topic: "sourdough" }), { undo: true });
    expect(ledgerTopics(ledger).find((t) => t.topic === "sourdough")?.weight).toBe(0.6);
    applyFeedback(ledger, "follow_topic", ctx({ topic: "sourdough" }), { undo: true });
    expect(ledgerTopics(ledger).find((t) => t.topic === "sourdough")).toBeUndefined();
    // Following an excluded topic un-excludes it.
    applyFeedback(ledger, "follow_topic", ctx({ topic: "celebrity news" }));
    expect(exclusions(ledger)).toEqual([]);
    const out = serializeLedger(ledger);
    expect(out).toContain("- celebrity news (0.60)");
    expect(out).not.toContain("!exclude");
  });

  it("not interested three times at the floor excludes the topic", () => {
    const ledger = parseLedger("- gadgets (0.30) — once\n");
    applyFeedback(ledger, "not_interested", ctx({ topics: ["gadgets"] }));
    expect(ledgerTopics(ledger)[0]?.weight).toBe(0.1);
    applyFeedback(ledger, "not_interested", ctx({ topics: ["gadgets"] }));
    expect(ledgerTopics(ledger)[0]?.weight).toBe(0.05);
    const changes = applyFeedback(ledger, "not_interested", ctx({ topics: ["gadgets"] }));
    expect(changes.at(-1)).toBe("- !exclude: gadgets — not interested 3× (last post p1)");
    expect(ledgerTopics(ledger)).toEqual([]);
    expect(exclusions(ledger)).toEqual(["gadgets"]);
  });

  it("a like on an unmatched post grows the ledger from the title", () => {
    const ledger = parseLedger("# Interests\n");
    expect(keyPhrase("A fresh look at sourdough starters")).toBe("fresh look sourdough starters");
    expect(
      applyFeedback(
        ledger,
        "like",
        ctx({ topics: [], title: "A fresh look at sourdough starters" }),
      ),
    ).toEqual(["- fresh look sourdough starters (0.40) — liked a post 2026-10-19 (post p1)"]);
    applyFeedback(
      ledger,
      "like",
      ctx({ topics: [], title: "A fresh look at sourdough starters" }),
      { undo: true },
    );
    expect(ledgerTopics(ledger)).toEqual([]);
    expect(serializeLedger(ledger)).toBe("# Interests\n");
  });
});
