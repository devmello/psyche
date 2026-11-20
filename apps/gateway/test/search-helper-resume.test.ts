import { describe, expect, it } from "vitest";
import {
  helperResumeHandler,
  PAIRING_APPROVED_EVENT,
} from "../src/compose/search-helper-resume.ts";

function harness(connected: boolean) {
  const calls = { resume: 0, tick: 0 };
  const state = { connected };
  const resume = helperResumeHandler({
    helperConnected: () => state.connected,
    resumeHelper: () => {
      calls.resume += 1;
    },
    tick: () => {
      calls.tick += 1;
    },
  });
  return { resume, calls, state };
}

/** The handler's tick runs after a microtask; let it land before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("helperResumeHandler", () => {
  it("a Host-helper connect clears the block and runs a tick at once", async () => {
    const { resume, calls } = harness(true);
    resume("connect");
    expect(calls.resume).toBe(1);
    await settle();
    expect(calls.tick).toBe(1);
  });

  it("a connect event with no helper up does nothing", async () => {
    const { resume, calls } = harness(false);
    resume("connect");
    await settle();
    expect(calls.resume).toBe(0);
    expect(calls.tick).toBe(0);
  });

  it("an approved pairing clears the block and runs a tick, even without a connect", async () => {
    const { resume, calls } = harness(false);
    resume("approval");
    expect(calls.resume).toBe(1);
    await settle();
    expect(calls.tick).toBe(1);
  });

  it("names the approval event the Gateway emits for an approved pairing", () => {
    expect(PAIRING_APPROVED_EVENT).toBe("device.updated");
  });

  it("a failing tick does not throw out of the handler", async () => {
    const resume = helperResumeHandler({
      helperConnected: () => true,
      resumeHelper: () => undefined,
      tick: () => {
        throw new Error("boom");
      },
    });
    expect(() => resume("connect")).not.toThrow();
    await settle();
  });
});
