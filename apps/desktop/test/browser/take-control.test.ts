import { describe, expect, it } from "vitest";
import {
  type ControlState,
  type ControlVia,
  TakeControl,
} from "../../src/main/browser/take-control.ts";

/** Manual clock and timer queue. */
class Clock {
  t = 1_000;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimer = (h: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (next === undefined || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

function setup(idleMs?: number) {
  const clock = new Clock();
  const changes: [ControlState, ControlVia][] = [];
  const tc = new TakeControl({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...(idleMs === undefined ? {} : { idleMs }),
    onChange: (s, v) => changes.push([s, v]),
  });
  let refused = 0;
  let accepted = 0;
  /** An agent Input.* command as the host runs it: refused while the user holds the tab. */
  const agent = (method: string, params: Record<string, unknown>, echoes: string[] = []) => {
    if (tc.isUserInControl()) {
      refused++;
      return false;
    }
    accepted++;
    tc.agentInputStart(method, params);
    for (const e of echoes) tc.onInputEvent(e);
    tc.agentInputEnd(method, params);
    return true;
  };
  /** Native keystroke: before-input-event keyDown/keyUp plus input-event rawKeyDown/char/keyUp. */
  const humanKey = () => {
    tc.onBeforeInputEvent("keyDown");
    tc.onInputEvent("rawKeyDown");
    tc.onInputEvent("char");
    tc.onBeforeInputEvent("keyUp");
    tc.onInputEvent("keyUp");
  };
  return {
    clock,
    tc,
    changes,
    agent,
    humanKey,
    counts: () => ({ refused, accepted }),
  };
}

const click = ["mouseMove", "mouseDown", "mouseUp"];

describe("TakeControl", () => {
  it("agent alone: no false grabs from insertText, clicks, key events or wheel", () => {
    const { clock, tc, changes, agent, counts } = setup();
    for (let i = 0; i < 30; i++) {
      agent("Input.insertText", { text: "x" });
      clock.advance(25);
      if (i % 6 === 0) {
        agent("Input.dispatchMouseEvent", { type: "mouseMoved" }, ["mouseMove"]);
        agent("Input.dispatchMouseEvent", { type: "mousePressed" }, ["mouseDown"]);
        agent("Input.dispatchMouseEvent", { type: "mouseReleased" }, ["mouseUp"]);
      }
      if (i % 10 === 0) agent("Input.dispatchKeyEvent", { type: "keyDown" }, ["keyDown"]);
      if (i % 15 === 0) {
        agent("Input.dispatchMouseEvent", { type: "mouseWheel" }, ["mouseWheel"]);
        // Trailing wheel/gesture events arrive after the command resolves.
        clock.advance(10);
        tc.onInputEvent("mouseWheel");
        tc.onInputEvent("gestureScrollUpdate");
        clock.advance(30);
        tc.onInputEvent("gestureScrollEnd");
      }
    }
    expect(changes).toEqual([]);
    expect(counts().refused).toBe(0);
    expect(tc.state).toBe("agent");
  });

  it("human typing mid-stream refuses the agent with no interleaving, then releases on idle", () => {
    const { clock, tc, changes, agent, humanKey, counts } = setup();
    const field: string[] = [];
    const type = (ch: string) => {
      if (agent("Input.insertText", { text: ch })) field.push(ch);
    };
    for (let i = 0; i < 10; i++) {
      type("x");
      clock.advance(25);
    }
    // "HUMAN": 5 keys over ~400 ms while the agent keeps trying every 25 ms.
    for (const ch of "HUMAN") {
      humanKey();
      field.push(ch);
      for (let k = 0; k < 4; k++) {
        type("x");
        clock.advance(25);
      }
    }
    expect(changes).toEqual([["user", "keyboard"]]);
    const refusedWhileTyping = counts().refused;
    expect(refusedWhileTyping).toBe(20);
    // Agent keeps trying; still refused until 1.5 s after the last key.
    let resumedAt = -1;
    const lastKey = clock.t - 100;
    for (let i = 0; i < 80 && resumedAt < 0; i++) {
      clock.advance(25);
      if (agent("Input.insertText", { text: "y" })) {
        field.push("y");
        resumedAt = clock.t;
      }
    }
    expect(changes).toEqual([
      ["user", "keyboard"],
      ["agent", "idle"],
    ]);
    expect(resumedAt - lastKey).toBeGreaterThanOrEqual(1_500);
    expect(resumedAt - lastKey).toBeLessThan(1_600);
    expect(field.join("")).toBe(`${"x".repeat(10)}HUMANy`);
    expect(tc.state).toBe("agent");
  });

  it("a user click grabs; hover alone never does", () => {
    const { clock, tc, changes } = setup();
    tc.onInputEvent("mouseMove");
    tc.onInputEvent("mouseMove");
    clock.advance(5_000);
    expect(changes).toEqual([]);
    for (const e of click) tc.onInputEvent(e);
    expect(changes).toEqual([["user", "mouse"]]);
    // mouseMove extends the active hold.
    clock.advance(1_000);
    tc.onInputEvent("mouseMove");
    clock.advance(1_000);
    expect(tc.isUserInControl()).toBe(true);
    clock.advance(600);
    expect(tc.state).toBe("agent");
    expect(changes.at(-1)).toEqual(["agent", "idle"]);
  });

  it("user wheel grabs only outside the agent's wheel grace window", () => {
    const { clock, tc, changes, agent } = setup();
    agent("Input.dispatchMouseEvent", { type: "mouseWheel", deltaY: 100 }, ["mouseWheel"]);
    clock.advance(49);
    tc.onInputEvent("mouseWheel");
    expect(changes).toEqual([]);
    clock.advance(1);
    tc.onInputEvent("mouseWheel");
    expect(changes).toEqual([["user", "mouse"]]);
  });

  it("ignores mouse while an agent command is in flight; keyboard still grabs", () => {
    const { tc, changes } = setup();
    tc.agentInputStart("Input.dispatchMouseEvent", { type: "mousePressed" });
    tc.onInputEvent("mouseDown");
    tc.onInputEvent("mouseWheel");
    expect(changes).toEqual([]);
    tc.onBeforeInputEvent("keyDown");
    expect(changes).toEqual([["user", "keyboard"]]);
    tc.agentInputEnd("Input.dispatchMouseEvent", { type: "mousePressed" });
    expect(tc.agentInputDepth).toBe(0);
  });

  it("sticky Take control holds until Release, ignoring idle", () => {
    const { clock, tc, changes, agent, counts } = setup();
    tc.setSticky(true);
    expect(changes).toEqual([["user", "button"]]);
    expect(agent("Input.insertText", { text: "x" })).toBe(false);
    clock.advance(2_000);
    tc.onBeforeInputEvent("keyDown");
    clock.advance(10_000);
    expect(tc.isUserInControl()).toBe(true);
    expect(agent("Input.insertText", { text: "x" })).toBe(false);
    tc.setSticky(false);
    expect(changes).toEqual([
      ["user", "button"],
      ["agent", "release"],
    ]);
    expect(agent("Input.insertText", { text: "x" })).toBe(true);
    expect(counts()).toEqual({ refused: 2, accepted: 1 });
  });

  it("Release ends an implicit hold immediately", () => {
    const { clock, tc, changes } = setup();
    tc.onBeforeInputEvent("keyDown");
    clock.advance(100);
    tc.setSticky(false);
    expect(changes).toEqual([
      ["user", "keyboard"],
      ["agent", "release"],
    ]);
    clock.advance(5_000);
    expect(changes).toHaveLength(2);
    // Releasing when nobody holds the tab is a no-op.
    tc.setSticky(false);
    expect(changes).toHaveLength(2);
  });

  it("honours a configured idle timeout and stops after dispose", () => {
    const { clock, tc, changes } = setup(300);
    tc.onInputEvent("mouseDown");
    clock.advance(299);
    expect(tc.isUserInControl()).toBe(true);
    clock.advance(1);
    expect(tc.state).toBe("agent");
    tc.dispose();
    tc.onInputEvent("mouseDown");
    expect(changes).toEqual([
      ["user", "mouse"],
      ["agent", "idle"],
    ]);
  });
});
