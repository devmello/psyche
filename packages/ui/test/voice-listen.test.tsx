import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { InboxScreen } from "../src/screens/inbox/InboxScreen.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";
import { FakeVoiceTerminal } from "../src/voice/fake-terminal.ts";

/** Listen on the spoken brief and check-ins (voice-mode-2026 §4.9), on the MockGateway. */

function setup(settings: Record<string, unknown> = {}) {
  const ref: { gateway?: MockGateway; terminal?: FakeVoiceTerminal } = {};
  render(
    <StoryWorld
      edit={(w) => {
        w.settings = { ...w.settings, ...settings };
      }}
      onGateway={(g) => {
        ref.gateway = g;
        ref.terminal = new FakeVoiceTerminal(g);
      }}
    >
      <Slots refs={ref} />
    </StoryWorld>,
  );
  return ref;
}

function Slots({ refs }: { refs: { terminal?: FakeVoiceTerminal } }) {
  return (
    <UiSlotsProvider value={refs.terminal ? { voiceTerminal: refs.terminal } : {}}>
      <InboxScreen />
    </UiSlotsProvider>
  );
}

describe("Listen in the inbox", () => {
  it("starts a conversation that speaks the brief, without Talk with Psyche on", async () => {
    const ref = setup();
    const row = (await screen.findByText("Brief ready")).closest("article") as HTMLElement;
    // "listen" is the voice terminal's, not a resolution: it appears once, as Listen.
    expect(within(row).getAllByRole("button", { name: "Listen" })).toHaveLength(1);
    await userEvent.click(within(row).getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(ref.terminal?.calls[0]?.method).toBe("voice.conversation.start"));
    expect(ref.terminal?.calls[0]?.params).toMatchObject({
      mode: "push",
      listen: { notificationId: expect.stringMatching(/./) },
    });
    const capsule = await screen.findByTestId("voice-capsule");
    await waitFor(() => expect(ref.gateway?.voiceConversation).toBeTruthy());
    act(() => {
      ref.gateway?.emit(
        "voice.conversation.state" as never,
        {
          conversationId: ref.gateway.voiceConversation,
          phase: "speaking",
          listening: false,
        } as never,
      );
    });
    expect(within(capsule).getByRole("status").textContent).toContain("Speaking");
    await userEvent.click(within(capsule).getByTestId("voice-end"));
    expect(screen.queryByTestId("voice-capsule")).toBeNull();
  });

  it("hides Listen while the spoken brief is off, and without a voice terminal", async () => {
    setup({ "voice.conversation.brief": "off" });
    await screen.findByText("Brief ready");
    expect(screen.queryByRole("button", { name: "Listen" })).toBeNull();
  });
});
