// @vitest-environment happy-dom
import type { VoiceTerminal } from "@psyche/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayEvent, GatewayStatus } from "../../src/client/index.ts";
import { VoiceHud, type VoiceHudBridge } from "../../src/compose/VoiceHud.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

afterEach(cleanup);

/** Voice HUD (voice-mode-2026 §6.2): the voice key from the Gateway drives a conversation. */
function setup(mode = "push") {
  const listeners = new Set<(e: GatewayEvent) => void>();
  const status: GatewayStatus = { phase: "paired", health: "ok", attempt: 0 };
  const platform: ShellPlatform = {
    kind: "desktop",
    gateway: {
      getStatus: async () => status,
      onStatus: () => () => {},
      call: async (method) => {
        if (method === "settings.get")
          return {
            settings: { "voice.conversation.enabled": true, "voice.conversation.mode": mode },
            stateVersion: 1,
          };
        if (method === "events.subscribe") return { ok: true };
        return {};
      },
      onEvent: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      onResync: () => () => {},
    },
    storage: { get: () => null, set: () => {} },
    notify: { show: () => {} },
  };
  const calls: string[] = [];
  const terminal: VoiceTerminal = {
    start: async () => {
      calls.push("start");
      return "vc_hud";
    },
    turn: (a) => calls.push(`turn:${a}`),
    mute: (m) => calls.push(`mute:${m}`),
    stopSpeaking: () => calls.push("stopSpeaking"),
    review: (_id, a) => calls.push(`review:${a}`),
    end: () => calls.push("end"),
    levels: () => ({ input: 0, output: 0 }),
  };
  const bridged: string[] = [];
  const bridge: VoiceHudBridge = {
    done: () => bridged.push("done"),
    openThread: (id) => bridged.push(`open:${id}`),
  };
  const emit = (event: string, payload: unknown) =>
    act(() => {
      for (const l of [...listeners]) l({ event, payload, seq: 1 } as GatewayEvent);
    });
  return { platform, terminal, bridge, calls, bridged, emit };
}

describe("VoiceHud", () => {
  it("starts on the voice key, begins the held turn once started, ends it on key up", async () => {
    const s = setup();
    render(<VoiceHud platform={s.platform} terminal={s.terminal} bridge={s.bridge} idleMs={50} />);
    // Settings load first (the HUD only listens with voice conversation on).
    await waitFor(() => expect(s.calls).toEqual([]));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    s.emit("dictation.key", { key: "rightCommand", down: true, at: "", role: "voice" });
    await waitFor(() => expect(s.calls).toContain("turn:begin"));
    expect(s.calls[0]).toBe("start");
    // The dictation key is ignored.
    s.emit("dictation.key", { key: "fn", down: true, at: "", role: "dictation" });
    s.emit("voice.conversation.state", {
      conversationId: "vc_hud",
      phase: "listening",
      listening: true,
    });
    expect(await screen.findByTestId("voice-hud")).toBeTruthy();
    s.emit("dictation.key", { key: "rightCommand", down: false, at: "", role: "voice" });
    expect(s.calls).toContain("turn:end");
    // Clicking the capsule opens the conversation in Psyche (the main chat).
    fireEvent.click(screen.getByTestId("voice-hud-open"));
    expect(s.bridged).toContain("open:null");
  });

  it("closes after the last reply", async () => {
    const s = setup();
    render(<VoiceHud platform={s.platform} terminal={s.terminal} bridge={s.bridge} idleMs={50} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    s.emit("dictation.key", { key: "rightCommand", down: true, at: "", role: "voice" });
    await waitFor(() => expect(s.calls).toContain("turn:begin"));
    s.emit("voice.conversation.state", {
      conversationId: "vc_hud",
      phase: "speaking",
      listening: false,
    });
    expect(s.bridged).toEqual([]);
    // Back to waiting for the key with the mic closed: 4 s (here 50 ms) later it closes.
    s.emit("voice.conversation.state", {
      conversationId: "vc_hud",
      phase: "listening",
      listening: false,
    });
    await waitFor(() => expect(s.bridged).toContain("done"));
    expect(s.calls).toContain("end");
  });
});
