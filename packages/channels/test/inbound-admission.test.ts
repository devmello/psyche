import { describe, expect, it } from "vitest";
import { harness, OWNER, STRANGER } from "./helpers.ts";

describe("inbound admission (security §10: inbound chat per sender)", () => {
  it("a refused message reaches neither the sink, the decision hook nor pairing", async () => {
    const seen: string[] = [];
    let open = true;
    const h = await harness({
      admitInbound: (channel, message) => {
        seen.push(`${channel.id}|${message.senderId}`);
        return open;
      },
    });
    await h.adapter.receive({ senderId: OWNER, text: "first" });
    expect(h.delivered).toHaveLength(1);
    open = false;
    await h.adapter.receive({ senderId: OWNER, text: "second" });
    await h.adapter.receive({ senderId: STRANGER, text: "let me in" });
    expect(h.delivered).toHaveLength(1);
    expect(h.decisions).toHaveLength(1);
    // The stranger never got a pairing code: admission runs before authorization.
    expect(h.events.filter((e) => e.event === "pairing.requested")).toHaveLength(0);
    expect(seen).toEqual([
      `${h.channel.id}|${OWNER}`,
      `${h.channel.id}|${OWNER}`,
      `${h.channel.id}|${STRANGER}`,
    ]);
  });

  it("without a hook every message is admitted", async () => {
    const h = await harness();
    for (let i = 0; i < 40; i++) await h.adapter.receive({ senderId: OWNER, text: `m${i}` });
    expect(h.delivered).toHaveLength(40);
  });
});
