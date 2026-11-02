import { describe, expect, it } from "vitest";
import { PageReadHub } from "../src/compose/page-reads.ts";

const page = { url: "https://a.example/x", text: "t", readAt: 1, partition: "profile" as const };

describe("PageReadHub", () => {
  it("delivers to subscribers, survives a throwing one, and stops after unsubscribe", () => {
    const hub = new PageReadHub();
    const got: string[] = [];
    hub.subscribe(() => {
      throw new Error("boom");
    });
    const off = hub.subscribe((p) => got.push(p.url));
    hub.emit(page);
    off();
    hub.emit(page);
    expect(got).toEqual(["https://a.example/x"]);
  });
  it("is a no-op without subscribers", () => {
    expect(() => new PageReadHub().emit(page)).not.toThrow();
  });
});
