// @vitest-environment happy-dom
import type { Thread } from "@psyche/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayEvent } from "../../src/client/connection.ts";
import { type GatewayStatus, INITIAL_STATUS } from "../../src/client/status.ts";
import { Composer } from "../../src/shell/components/Chat.tsx";
import { VoiceModeBar } from "../../src/shell/components/VoiceModeBar.tsx";
import { ShellProvider } from "../../src/shell/context.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";
import { ShellStore } from "../../src/shell/store.ts";
import type { VoiceModeSettings } from "../../src/shell/voice-mode.ts";

afterEach(cleanup);

const thread = { id: "thr_1", title: "Main", kind: "main" } as Thread;

function composer(settings: Record<string, unknown>) {
  const statusCbs = new Set<(s: GatewayStatus) => void>();
  const eventCbs = new Set<(e: GatewayEvent) => void>();
  const calls: string[] = [];
  const platform: ShellPlatform = {
    kind: "web",
    gateway: {
      getStatus: async () => INITIAL_STATUS,
      onStatus: (cb) => {
        statusCbs.add(cb);
        return () => statusCbs.delete(cb);
      },
      onEvent: (cb) => {
        eventCbs.add(cb);
        return () => eventCbs.delete(cb);
      },
      onResync: () => () => undefined,
      call: async (m) => {
        calls.push(m);
        if (m === "settings.get") return { settings, stateVersion: 1 };
        if (m === "threads.list") return { threads: [], nextCursor: null };
        if (m === "approvals.list") return { approvals: [] };
        return { notifications: [], nextCursor: null };
      },
    },
    storage: { get: () => null, set: () => {} },
    notify: { show: () => {} },
  };
  const store = new ShellStore(platform.gateway);
  store.start();
  for (const cb of statusCbs) cb({ ...INITIAL_STATUS, health: "ok", phase: "paired" });
  render(
    <ShellProvider platform={platform} store={store} mac={true}>
      <Composer
        thread={thread}
        disabled={false}
        running={false}
        onModeCycle={() => {}}
        focusToken={0}
      />
    </ShellProvider>,
  );
  const emit = (event: string, payload: unknown) => {
    for (const cb of eventCbs) cb({ event, payload, seq: 1, stateVersion: 1 });
  };
  return { calls, emit };
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("voice mode in the composer (Q5)", () => {
  it("has no Voice button while the setting is off, and gains one when it is turned on", async () => {
    const { calls, emit } = composer({});
    await flush();
    expect(calls).toContain("settings.get");
    expect(screen.queryByTestId("voice-mode-toggle")).toBeNull();
    expect(screen.queryByTestId("voice-mode")).toBeNull();
    await act(async () => {
      emit("settings.changed", { entries: [{ key: "voice.conversation.enabled", value: true }] });
    });
    expect(screen.getByTestId("voice-mode-toggle").textContent).toBe("Voice");
    // Nothing starts on its own.
    expect(calls).not.toContain("voice.start");
    // No Gateway serves commands.list; the composer uses its built-in list (#554).
    expect(calls).not.toContain("commands.list");
  });

  it("shows the Voice button when the setting is already on", async () => {
    composer({ "voice.conversation.enabled": true });
    await flush();
    expect(screen.getByTestId("voice-mode-toggle").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("voice mode state bar", () => {
  const settings: VoiceModeSettings = {
    enabled: true,
    start: "push",
    reply: "gateway",
    bargeIn: true,
  };
  const noop = () => {};

  it("announces each state politely and offers hold to talk and End", () => {
    const { rerender } = render(
      <VoiceModeBar
        state={{ phase: "listening", partial: "what's on" }}
        settings={settings}
        onEnd={noop}
        onPushStart={noop}
        onPushEnd={noop}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Listening");
    expect(screen.getByText("what's on")).toBeTruthy();
    expect(screen.getByTestId("voice-mode-talk")).toBeTruthy();
    rerender(
      <VoiceModeBar
        state={{ phase: "speaking", messageId: "m" }}
        settings={settings}
        onEnd={noop}
        onPushStart={noop}
        onPushEnd={noop}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Speaking · talk to interrupt");
    rerender(
      <VoiceModeBar
        state={{ phase: "waiting", reason: "approval" }}
        settings={settings}
        onEnd={noop}
        onPushStart={noop}
        onPushEnd={noop}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Needs your approval on screen");
    expect((screen.getByTestId("voice-mode-talk") as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <VoiceModeBar
        state={{ phase: "off" }}
        settings={settings}
        onEnd={noop}
        onPushStart={noop}
        onPushEnd={noop}
      />,
    );
    expect(screen.queryByTestId("voice-mode")).toBeNull();
  });
});
