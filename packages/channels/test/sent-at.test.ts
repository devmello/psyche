import { describe, expect, it } from "vitest";
import { slackSentAt } from "../src/adapters/slack/mapping.ts";
import { waSentAt } from "../src/adapters/whatsapp/mapping.ts";

/** A plain answer is bound to the platform's send time, not the Gateway's arrival time. */

describe("send time of an inbound message", () => {
  it("Slack: the event's own ts in ms; for an edit the edited message's ts; else 0", () => {
    expect(slackSentAt({ type: "message", ts: "1700000000.000200" } as never)).toBeCloseTo(
      1_700_000_000_000.2,
      0,
    );
    expect(
      slackSentAt({
        type: "message",
        subtype: "message_changed",
        ts: "1700000999.000100",
        message: { ts: "1700000000.000200" },
      } as never),
    ).toBeCloseTo(1_700_000_000_000.2, 0);
    for (const ts of [undefined, "", "abc", "0"]) {
      expect(slackSentAt({ type: "message", ts } as never)).toBe(0);
    }
    expect(slackSentAt({ type: "message", subtype: "message_changed" } as never)).toBe(0);
  });

  it("WhatsApp: the message timestamp (seconds) in ms; missing or not a number is 0", () => {
    expect(waSentAt({ timestamp: "1700000000" })).toBe(1_700_000_000_000);
    expect(waSentAt({ timestamp: 1_700_000_000 })).toBe(1_700_000_000_000);
    for (const timestamp of [undefined, "", "soon", null, Number.NaN]) {
      expect(waSentAt({ timestamp })).toBe(0);
    }
  });
});
