import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MotionConfig } from "motion/react";
import { describe, expect, it } from "vitest";
import { ChatThread } from "../src/chat/Thread.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { IDS } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";
import { FakeVoiceTerminal } from "../src/voice/fake-terminal.ts";
import { envelope, glowFor, Lantern } from "../src/voice/Lantern.tsx";
import { IDLE_SESSION, micOn, voiceReducer } from "../src/voice/session.ts";

/** Voice U2: the capsule through every phase on the MockGateway (voice-mode-2026 §6.1, §7). */

function setup(settings: Record<string, unknown> = {}) {
  const ref: { gateway?: MockGateway; terminal?: FakeVoiceTerminal } = {};
  render(
    <StoryWorld
      edit={(w) => {
        w.settings = { ...w.settings, "voice.conversation.enabled": true, ...settings };
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
      <ChatThread threadId={IDS.threads.main} />
    </UiSlotsProvider>
  );
}

function emit(g: MockGateway | undefined, event: string, payload: Record<string, unknown>) {
  act(() => {
    g?.emit(event as never, { conversationId: g.voiceConversation, ...payload } as never);
  });
}

describe("the voice session (pure)", () => {
  it("follows the Gateway's phases and keeps Mic on honest", () => {
    let s = voiceReducer(IDLE_SESSION, { type: "starting", mode: "handsfree" });
    s = voiceReducer(s, { type: "started", conversationId: "vc_1" });
    expect(micOn(s)).toBe(false);
    s = voiceReducer(s, {
      type: "state",
      payload: { conversationId: "vc_1", phase: "listening", listening: true },
      at: 0,
    });
    expect(micOn(s)).toBe(true);
    s = voiceReducer(s, { type: "muted", muted: true });
    expect(micOn(s)).toBe(false);
    // Another conversation's events are ignored.
    const other = voiceReducer(s, {
      type: "state",
      payload: { conversationId: "vc_2", phase: "speaking", listening: false },
      at: 0,
    });
    expect(other).toBe(s);
    s = voiceReducer(s, {
      type: "ended",
      payload: { conversationId: "vc_1", reason: "idle" },
    });
    expect(s.phase).toBe("idle");
    expect(s.ended?.reason).toBe("idle");
  });
});

describe("the lantern (§6.3)", () => {
  it("rises fast and falls slowly, and maps levels to scale and opacity", () => {
    const up = envelope(0, 0.2, 80);
    expect(up).toBeGreaterThan(0.12);
    const down = envelope(0.2, 0, 80);
    expect(down).toBeGreaterThan(0.12);
    expect(glowFor(0)).toEqual({ scale: 1, opacity: 0.35 });
    expect(glowFor(1)).toEqual({ scale: 1.12, opacity: 0.85 });
  });

  it("animates no transform under reduced motion", () => {
    const { container } = render(
      <MotionConfig reducedMotion="always">
        <Lantern state="speaking" name="Wren" levels={() => ({ input: 0.3, output: 0.3 })} />
      </MotionConfig>,
    );
    const glow = container.querySelector("[data-glow]") as HTMLElement;
    expect(glow.style.transform).toBe("");
    expect(glow.className).not.toMatch(/psy-voice-(thinking|heard)/);
    expect(container.querySelector("[data-lantern]")?.getAttribute("data-reduced")).toBe("true");
  });
});

describe("the voice capsule on the MockGateway", () => {
  it("morphs from the composer, follows every phase, and ends back to the composer", async () => {
    const ref = setup();
    const voice = await screen.findByRole("button", { name: "Voice" });
    await userEvent.click(voice);
    const capsule = await screen.findByTestId("voice-capsule");
    await waitFor(() => expect(ref.gateway?.voiceConversation).toBeTruthy());
    expect(ref.terminal?.calls[0]?.method).toBe("voice.conversation.start");
    expect(ref.terminal?.calls[0]?.params).toMatchObject({ mode: "push" });
    const chip = within(capsule).getByTestId("mic-chip");
    expect(chip.textContent).toBe("Mic off");

    // Listening, push to talk: hold to talk sends begin and end.
    emit(ref.gateway, "voice.conversation.state", { phase: "listening", listening: true });
    expect(within(capsule).getByRole("status").textContent).toContain("Listening");
    expect(chip.textContent).toBe("Mic on");
    const talk = within(capsule).getByTestId("voice-talk");
    fireEvent.pointerDown(talk);
    fireEvent.pointerUp(talk);
    expect(ref.terminal?.calls.filter((c) => c.method === "voice.conversation.turn")).toHaveLength(
      2,
    );
    emit(ref.gateway, "voice.conversation.caption", {
      role: "owner",
      utteranceId: "u1",
      text: "Send Alice the notes",
      final: true,
    });
    expect(within(capsule).getByTestId("voice-caption").textContent).toBe("Send Alice the notes");

    // Thinking with a step line; the mic is off.
    emit(ref.gateway, "voice.conversation.state", { phase: "thinking", listening: false });
    emit(ref.gateway, "voice.conversation.step", {
      toolCallId: "tc_1",
      label: "Checking your calendar",
      status: "running",
    });
    expect(within(capsule).getByTestId("voice-step").textContent).toContain(
      "Checking your calendar",
    );
    expect(chip.textContent).toBe("Mic off");

    // Waiting on an approval: the readback, then speaking with Stop speaking.
    emit(ref.gateway, "voice.conversation.state", {
      phase: "waiting",
      reason: "approval",
      approvalId: "apr_1",
      prompt: "Send an email to alice@example.org. Say send it or cancel.",
      windowMs: 10_000,
      listening: true,
    });
    expect(within(capsule).getByTestId("voice-readback").textContent).toContain("send it");
    emit(ref.gateway, "voice.conversation.state", { phase: "speaking", listening: false });
    await userEvent.click(within(capsule).getByTestId("voice-stop-speaking"));
    expect(ref.terminal?.calls.at(-1)).toMatchObject({
      method: "voice.conversation.interrupt",
      params: { stage: "confirmed" },
    });

    // Ended by the Gateway: the composer is back.
    emit(ref.gateway, "voice.conversation.ended", { reason: "idle" });
    await waitFor(() => expect(screen.queryByTestId("voice-capsule")).toBeNull());
    expect(screen.getByTestId("composer-capsule")).toBeTruthy();
  });

  it("holds the owner's words for review, sends them as edited, or discards them (§4.10)", async () => {
    const ref = setup({ "voice.conversation.reviewBeforeSend": true });
    await userEvent.click(await screen.findByRole("button", { name: "Voice" }));
    const capsule = await screen.findByTestId("voice-capsule");
    await waitFor(() => expect(ref.gateway?.voiceConversation).toBeTruthy());
    const review = (utteranceId: string, draft: string) =>
      emit(ref.gateway, "voice.conversation.state", {
        phase: "waiting",
        reason: "review",
        draft,
        utteranceId,
        listening: false,
      });

    review("u1", "Tell Sam I'm running late");
    expect(within(capsule).getByRole("status").textContent).toContain("Check your words");
    expect(within(capsule).getByTestId("mic-chip").textContent).toBe("Mic off");
    const field = within(capsule).getByRole("textbox", { name: /heard/ });
    expect((field as HTMLTextAreaElement).value).toBe("Tell Sam I'm running late");
    // Space types into the field; it doesn't start a turn.
    await userEvent.clear(field);
    await userEvent.type(field, "Tell Sam I'm ten minutes late{Enter}");
    expect(ref.terminal?.calls.some((c) => c.method === "voice.conversation.turn")).toBe(false);
    expect(ref.terminal?.calls.at(-1)).toEqual({
      method: "voice.conversation.review",
      params: {
        conversationId: ref.gateway?.voiceConversation,
        utteranceId: "u1",
        action: "send",
        text: "Tell Sam I'm ten minutes late",
      },
    });

    // Sent unchanged, the draft goes as heard; Discard drops it.
    emit(ref.gateway, "voice.conversation.state", { phase: "thinking", listening: false });
    expect(within(capsule).queryByTestId("voice-review")).toBeNull();
    review("u2", "Call mom");
    await userEvent.click(within(capsule).getByTestId("voice-review-send"));
    expect(ref.terminal?.calls.at(-1)?.params).toMatchObject({ utteranceId: "u2", action: "send" });
    expect(ref.terminal?.calls.at(-1)?.params).not.toHaveProperty("text");
    review("u3", "Never mind");
    await userEvent.click(within(capsule).getByTestId("voice-review-discard"));
    expect(ref.terminal?.calls.at(-1)?.params).toMatchObject({
      utteranceId: "u3",
      action: "discard",
    });
  });

  it("mutes hands-free (the mic chip goes off) and ends with End", async () => {
    const ref = setup({ "voice.conversation.mode": "handsfree" });
    await userEvent.click(await screen.findByRole("button", { name: "Voice" }));
    const capsule = await screen.findByTestId("voice-capsule");
    await waitFor(() => expect(ref.gateway?.voiceConversation).toBeTruthy());
    emit(ref.gateway, "voice.conversation.state", { phase: "listening", listening: true });
    const chip = within(capsule).getByTestId("mic-chip");
    expect(chip.textContent).toBe("Mic on");
    await userEvent.click(within(capsule).getByTestId("voice-mute"));
    expect(chip.textContent).toBe("Mic off");
    expect(ref.terminal?.muted).toBe(true);
    await userEvent.click(within(capsule).getByRole("button", { name: "End" }));
    await waitFor(() => expect(screen.queryByTestId("voice-capsule")).toBeNull());
    expect(ref.terminal?.calls.at(-1)?.method).toBe("voice.conversation.stop");
  });

  it("says why it can't start", async () => {
    const ref: { gateway?: MockGateway } = {};
    render(
      <StoryWorld
        edit={(w) => {
          w.settings = { ...w.settings, "voice.conversation.enabled": true };
        }}
        onGateway={(g) => {
          ref.gateway = g;
        }}
      >
        <FailingSlots />
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Voice" }));
    expect((await screen.findByTestId("voice-error")).textContent).toBe(
      "Psyche needs the microphone to hear you",
    );
  });
});

function FailingSlots() {
  const terminal = new FakeVoiceTerminal(
    { request: async () => ({}), subscribe: () => () => {} } as never,
    { failWith: "Psyche needs the microphone to hear you" },
  );
  return (
    <UiSlotsProvider value={{ voiceTerminal: terminal }}>
      <ChatThread threadId={IDS.threads.main} />
    </UiSlotsProvider>
  );
}
