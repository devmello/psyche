// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayEvent } from "../../src/client/connection.ts";
import { type GatewayStatus, INITIAL_STATUS } from "../../src/client/status.ts";
import { MeetingRecord, requestRecordMeeting } from "../../src/shell/components/MeetingRecord.tsx";
import { ShellProvider } from "../../src/shell/context.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";
import { ShellStore } from "../../src/shell/store.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function shell() {
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
        if (m === "meetings.record.status") {
          return {
            available: true,
            recording: false,
            consentLine: "Quick note: I'm recording this meeting.",
            startedAt: null,
            meetingId: null,
          };
        }
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
      <MeetingRecord />
    </ShellProvider>,
  );
  const emit = (event: string, payload: unknown) => {
    for (const cb of eventCbs) cb({ event, payload, seq: 1, stateVersion: 1 });
  };
  return { calls, emit };
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("Record meeting dialog and pill (§4.6)", () => {
  it("asks first: the consent line, and no microphone until 'I've told everyone'", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia }, clipboard: undefined });
    const { calls } = shell();
    expect(screen.queryByTestId("meeting-record-consent")).toBeNull();
    await act(async () => requestRecordMeeting("ev1"));
    await flush();
    expect(screen.getByTestId("meeting-record-line").textContent).toMatch(/recording this meeting/);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(calls).not.toContain("meetings.record.start");
    // Cancel records nothing.
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("meeting-record-consent")).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    // Confirm with the microphone refused: a message, still no start call.
    await act(async () => requestRecordMeeting());
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByText("I've told everyone"));
    });
    await flush();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(calls).not.toContain("meetings.record.start");
    expect(screen.getByTestId("meeting-record-error").textContent).toMatch(/microphone/);
  });

  it("shows the recording pill while any device records, and the notes line afterwards", async () => {
    const { emit } = shell();
    await flush();
    await act(async () => {
      emit("meetings.recording.updated", {
        available: true,
        recording: true,
        consentLine: "x",
        startedAt: new Date().toISOString(),
        meetingId: null,
      });
    });
    expect(screen.getByTestId("meeting-record-pill").textContent).toMatch(
      /Recording meeting · 0:0/,
    );
    await act(async () => {
      emit("meetings.recording.updated", {
        available: true,
        recording: false,
        consentLine: "x",
        startedAt: null,
        meetingId: null,
        last: {
          startedAt: new Date().toISOString(),
          durationMs: 1000,
          reason: "stopped",
          notes: "processing",
        },
      });
    });
    expect(screen.queryByTestId("meeting-record-pill")).toBeNull();
    expect(screen.getByTestId("meeting-record-notes")).toBeTruthy();
  });
});
