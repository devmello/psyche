import { describe, expect, it } from "vitest";
import { PushToTalk } from "../../src/compose/push-to-talk.ts";
import { type AudioSource, VoiceCapture, type VoiceState } from "../../src/shell/voice.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A real VoiceCapture over a fake Gateway and microphone; `voice.start` waits for `release`. */
function harness(transcript = "what's on my calendar") {
  const calls: string[] = [];
  let release: () => void = () => {};
  const started = new Promise<void>((r) => {
    release = r;
  });
  const call = async (method: string) => {
    calls.push(method);
    if (method === "voice.start") {
      await started;
      return { sessionId: "vs_1", location: "node" };
    }
    if (method === "voice.stop") return { transcript: { text: transcript } };
    return {};
  };
  let micOpen = false;
  const source: AudioSource = {
    start: async () => {
      micOpen = true;
      return () => {
        micOpen = false;
      };
    },
  };
  const states: VoiceState["phase"][] = [];
  const done: string[] = [];
  let ptt: PushToTalk | undefined;
  const capture = new VoiceCapture(call, source, (s) => {
    states.push(s.phase);
    ptt?.onState(s);
  });
  ptt = new PushToTalk(capture, (t) => done.push(t));
  return { ptt, capture, calls, done, states, release, mic: () => micOpen };
}

describe("PushToTalk", () => {
  it("down starts, up finishes and hands over the words", async () => {
    const h = harness();
    h.ptt.down();
    h.release();
    await tick();
    expect(h.capture.getState().phase).toBe("listening");
    expect(h.mic()).toBe(true);
    h.ptt.up();
    await tick();
    expect(h.done).toEqual(["what's on my calendar"]);
    expect(h.mic()).toBe(false);
    expect(h.calls).toEqual(["voice.start", "voice.stop"]);
  });

  it("a release while voice.start is in flight finishes once listening (a quick tap)", async () => {
    const h = harness("hi");
    h.ptt.down();
    h.ptt.up();
    expect(h.capture.getState().phase).toBe("starting");
    h.release();
    await tick();
    await tick();
    expect(h.done).toEqual(["hi"]);
    expect(h.capture.getState().phase).toBe("idle");
    expect(h.mic()).toBe(false);
  });

  it("key repeats while held start nothing new", async () => {
    const h = harness();
    h.ptt.down();
    h.ptt.down();
    h.release();
    await tick();
    expect(h.calls.filter((c) => c === "voice.start")).toHaveLength(1);
    expect(h.ptt.held).toBe(true);
  });

  it("cancel drops what was heard, even mid-finish, and sends nothing", async () => {
    const h = harness();
    h.ptt.down();
    h.release();
    await tick();
    h.ptt.up();
    h.ptt.cancel();
    await tick();
    expect(h.done).toEqual([]);
    expect(h.capture.getState().phase).toBe("idle");
  });

  it("an empty transcript hands over nothing", async () => {
    const h = harness("   ");
    h.ptt.down();
    h.release();
    await tick();
    h.ptt.up();
    await tick();
    expect(h.done).toEqual([]);
  });
});
