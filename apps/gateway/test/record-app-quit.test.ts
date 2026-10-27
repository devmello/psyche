import type { CapturedAudio } from "@psyche/proactive";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { RecordMeeting } from "../src/compose/meetings.ts";

/** Record meeting ends when the conference app quits (#842 item 8); a fake capture and app list. */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A capture that runs until it is stopped, so only the app watch or the owner can end it. */
function fakeCapture() {
  const reasons: string[] = [];
  return {
    reasons,
    capture: {
      start: async () => {
        let end: (a: CapturedAudio) => void = () => {};
        const ended = new Promise<CapturedAudio>((resolve) => {
          end = resolve;
        });
        return {
          stop: async (reason?: CapturedAudio["reason"]) => {
            reasons.push(reason ?? "stopped");
            const audio: CapturedAudio = {
              path: "/nonexistent/meeting.wav",
              startedAt: new Date(0).toISOString(),
              durationMs: 1_000,
              reason: reason ?? "stopped",
            };
            end(audio);
            return audio;
          },
          ended,
        };
      },
    },
  };
}

function rig(apps: { running: string[] | undefined }) {
  const fake = fakeCapture();
  const record = new RecordMeeting({
    notes: { fromRecording: async () => undefined } as never,
    clock: new FakeClock(Date.parse("2026-10-26T14:00:00Z")),
    capture: () => fake.capture as never,
    publish: () => {},
    runningApps: async () => apps.running,
    appPollMs: 5,
  });
  return { record, reasons: fake.reasons };
}

async function until(cond: () => boolean, ms = 1_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(5);
}

describe("Record meeting ends when the conference app quits", () => {
  it("stops with app_quit once the conference app that was running is gone", async () => {
    const apps = { running: ["us.zoom.xos", "com.apple.Safari"] as string[] | undefined };
    const r = rig(apps);
    await r.record.start({ consentConfirmed: true, meetingId: "e1" }, "dev_1");
    apps.running = ["com.apple.Safari"];
    await until(() => r.reasons.length > 0);
    expect(r.reasons).toEqual(["app_quit"]);
    expect(r.record.status().recording).toBe(false);
  });

  it("keeps recording while the conference app still runs", async () => {
    const apps = { running: ["us.zoom.xos"] as string[] | undefined };
    const r = rig(apps);
    await r.record.start({ consentConfirmed: true, meetingId: "e1" }, "dev_1");
    await sleep(40);
    expect(r.reasons).toEqual([]);
    expect(r.record.status().recording).toBe(true);
    await r.record.stop();
  });

  it("does not watch when no conference app runs at start", async () => {
    const apps = { running: ["com.apple.Safari"] as string[] | undefined };
    const r = rig(apps);
    await r.record.start({ consentConfirmed: true, meetingId: "e1" }, "dev_1");
    apps.running = [];
    await sleep(40);
    expect(r.reasons).toEqual([]);
    await r.record.stop();
  });

  it("does not end the recording when the helper cannot list the apps", async () => {
    const apps = { running: ["us.zoom.xos"] as string[] | undefined };
    const r = rig(apps);
    await r.record.start({ consentConfirmed: true, meetingId: "e1" }, "dev_1");
    apps.running = undefined;
    await sleep(40);
    expect(r.reasons).toEqual([]);
    await r.record.stop();
  });
});
