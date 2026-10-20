import { describe, expect, it } from "vitest";
import { type AttentionReport, createAttentionReporter } from "../../src/main/browser/attention.ts";

describe("attention reporter (pause-when-unwatched, #272)", () => {
  const setup = (fail = false) => {
    const sent: AttentionReport[] = [];
    const clock = { now: 1_000_000 };
    const r = createAttentionReporter({
      send: async (report) => {
        sent.push(report);
        if (fail) throw new Error("unknown_method");
      },
      now: () => clock.now,
      inputEveryMs: 30_000,
    });
    return { r, sent, clock };
  };

  it("sends visibility on change only, and input at most every 30 s", async () => {
    const { r, sent, clock } = setup();
    r.visible(true);
    r.visible(true);
    r.input();
    r.input();
    clock.now += 29_000;
    r.input();
    clock.now += 2_000;
    r.input();
    r.visible(false);
    expect(sent).toEqual([
      { pane: "browser", visible: true },
      { pane: "browser", visible: true, input: true },
      { pane: "browser", visible: true, input: true },
      { pane: "browser", visible: false },
    ]);
  });

  it("re-sends the known state after a reconnect, and nothing before it knows any", () => {
    const { r, sent } = setup();
    r.resend();
    expect(sent).toEqual([]);
    r.visible(false);
    r.resend();
    expect(sent).toEqual([
      { pane: "browser", visible: false },
      { pane: "browser", visible: false },
    ]);
  });

  it("ignores a Gateway that does not know the method yet", async () => {
    const { r, sent } = setup(true);
    expect(() => r.visible(true)).not.toThrow();
    await new Promise((res) => setTimeout(res, 0));
    expect(sent).toHaveLength(1);
  });
});
