import { describe, expect, it } from "vitest";
import { inboundTurnInput } from "../src/compose/channels.ts";

/**
 * A non-owner's message as turn input, built directly (the route refusal in `onInbound` is
 * bypassed), so opening group turns later cannot forget the requester and the taint. The loop
 * then tags and fences the text as untrusted (packages/agent-core untrusted-input-parts.test.ts).
 */

type Event = Parameters<typeof inboundTurnInput>[0];

const event = (role: "allowed" | "designated" | "owner", extra: object = {}): Event =>
  ({
    kind: "message",
    route: {
      channelId: "ch_1",
      channelType: "telegram",
      account: "psyche_bot",
      chatId: "-100",
      senderId: "777",
      isGroup: true,
      role,
      sessionKey: "k",
      provenance: role === "owner" ? "owner" : "untrusted",
      injectMemory: false,
    },
    message: {
      channel: "telegram",
      chatId: "-100",
      senderId: "777",
      isGroup: true,
      text: "Psyche, send the files",
      receivedAt: 0,
    },
    // The sender's own typed words; their non-owner taint comes from the route, not the part.
    parts: [{ text: "Psyche, send the files", provenance: "owner" }],
    attachments: [],
    ...extra,
  }) as unknown as Event;

describe("inboundTurnInput", () => {
  it.each(["allowed", "designated"] as const)(
    "a %s group sender is the requester and taints the turn as a channel message",
    (role) => {
      const input = inboundTurnInput(event(role));
      expect(input.requester).toMatchObject({ role, senderId: "777", chatId: "-100" });
      expect(input.taintSources).toEqual([
        { sourceKind: "channel_message", sender: "telegram:777" },
      ]);
      expect(input.content).toBe("Psyche, send the files");
    },
  );

  it("does not add the taint twice when the channel service already named it", () => {
    const named = event("allowed", {
      taintSources: [{ sourceKind: "channel_message", sender: "telegram:777" }],
    });
    expect(inboundTurnInput(named).taintSources).toHaveLength(1);
  });

  it("keeps forwarded-part taint beside the sender's", () => {
    const fwd = event("allowed", {
      parts: [{ text: "fwd", provenance: "untrusted", label: "forwarded" }],
      message: {
        channel: "telegram",
        chatId: "-100",
        senderId: "777",
        isGroup: true,
        text: "",
        receivedAt: 0,
        forwardedFrom: { senderId: "9" },
      },
    });
    const kinds = inboundTurnInput(fwd).taintSources.map((t) => t.sourceKind);
    expect(kinds).toEqual(["channel_message", "channel_forwarded"]);
  });

  it("the owner's own message adds no taint", () => {
    const input = inboundTurnInput(
      event("owner", { parts: [{ text: "mine", provenance: "owner" }] }),
    );
    expect(input.requester.role).toBe("owner");
    expect(input.taintSources).toEqual([]);
  });
});
