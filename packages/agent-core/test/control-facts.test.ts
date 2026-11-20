import { financialBlock } from "@psyche/protocol/financial-block";
import { describe, expect, it } from "vitest";
import { controlFacts } from "../src/loop.ts";

/** What the broker receives of a control: bounded, and never losing the word the hard block reads. */
describe("controlFacts", () => {
  it("keeps the fields the hard block reads and drops the rest", () => {
    const out = controlFacts({
      labels: ["Buy"],
      alsoLabels: ["Chart"],
      role: "link",
      href: "https://robinhood.com/x",
      submits: true,
      unreadable: true,
      formMethod: "post",
      formAction: "https://robinhood.com/orders",
      pageUrl: "https://robinhood.com/",
      pageTitle: "Order",
      secret: "x",
    } as never);
    expect(out).toEqual({
      labels: ["Buy"],
      alsoLabels: ["Chart"],
      role: "link",
      href: "https://robinhood.com/x",
      submits: true,
      unreadable: true,
      formMethod: "post",
      formAction: "https://robinhood.com/orders",
      pageUrl: "https://robinhood.com/",
      pageTitle: "Order",
    });
  });

  it("a long label keeps its tail, so padding cannot push a trailing Buy out of view", () => {
    const padded = `${"x ".repeat(300)}Buy`;
    const out = controlFacts({ labels: [padded] });
    expect(out.labels?.[0]?.length).toBeLessThan(500);
    expect(financialBlock({ origin: "https://robinhood.com", labels: out.labels })).toBeDefined();
  });

  it("at most twelve labels and no non-strings", () => {
    const out = controlFacts({
      labels: ["a", 1, ...Array.from({ length: 20 }, (_, i) => `l${i}`)] as never,
    });
    expect(out.labels).toHaveLength(12);
  });
});
