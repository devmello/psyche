import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { HelperAvailability, isNeedsHelper } from "../src/compose/helper-availability.ts";

const needsHelper = () =>
  new PsycheError(
    "unavailable",
    "Apple Mail needs the Psyche helper on your Mac: open the Psyche desktop app on the Mac and allow it to pair",
    { details: { reason: "needs_helper", app: "mail" }, retryable: true },
  );

function harness(initiallyConnected: boolean) {
  let t = 1_000_000;
  const logs: { level: string; msg: string }[] = [];
  const changes: boolean[] = [];
  const a = new HelperAvailability(initiallyConnected, {
    now: () => t,
    log: (level, msg) => logs.push({ level, msg }),
    baseMs: 60_000,
    maxMs: 30 * 60_000,
    onChange: (s) => changes.push(s.connected),
  });
  return {
    a,
    logs,
    changes,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("isNeedsHelper", () => {
  it("matches the helper error by its reason, and by the message alone", () => {
    expect(isNeedsHelper(needsHelper())).toBe(true);
    expect(isNeedsHelper(new Error("Apple Notes needs the Psyche helper on your Mac"))).toBe(true);
  });

  it("ignores other failures", () => {
    expect(isNeedsHelper(new Error("timeout"))).toBe(false);
    expect(
      isNeedsHelper(new PsycheError("unavailable", "rate limited", { details: { reason: "x" } })),
    ).toBe(false);
  });
});

describe("HelperAvailability", () => {
  it("attempts while connected and logs nothing on a no-op observe", () => {
    const h = harness(true);
    expect(h.a.shouldAttempt()).toBe(true);
    h.a.observe(true);
    expect(h.logs).toEqual([]);
    expect(h.changes).toEqual([]);
  });

  it("backs off exponentially on repeated failures and caps the step", () => {
    const h = harness(true);
    expect(h.a.noteFailure(needsHelper())).toBe(true);
    expect(h.a.shouldAttempt()).toBe(false);
    h.advance(59_999);
    expect(h.a.shouldAttempt()).toBe(false);
    h.advance(1);
    expect(h.a.shouldAttempt()).toBe(true);

    // Second failure: 2 minutes. Third: 4 minutes.
    h.a.noteFailure(needsHelper());
    h.advance(119_999);
    expect(h.a.shouldAttempt()).toBe(false);
    h.advance(1);
    h.a.noteFailure(needsHelper());
    h.advance(4 * 60_000 - 1);
    expect(h.a.shouldAttempt()).toBe(false);
    h.advance(1);
    expect(h.a.shouldAttempt()).toBe(true);

    // Many failures never wait longer than the cap.
    for (let i = 0; i < 20; i++) h.a.noteFailure(needsHelper());
    expect(h.a.status().retryAt - 1_000_000).toBeLessThanOrEqual(30 * 60_000 + 10 * 60_000);
    h.advance(30 * 60_000);
    expect(h.a.shouldAttempt()).toBe(true);
  });

  it("logs once when the helper goes offline, not once per failed cycle", () => {
    const h = harness(true);
    h.a.noteFailure(needsHelper());
    h.advance(60_000);
    h.a.noteFailure(needsHelper());
    h.a.noteFailure(needsHelper());
    expect(h.logs.filter((l) => l.level === "warn")).toHaveLength(1);
    expect(h.changes).toEqual([false, false, false]);
  });

  it("resumes at once on reconnect and logs the transition", () => {
    const h = harness(true);
    h.a.noteFailure(needsHelper());
    h.a.noteFailure(needsHelper());
    expect(h.a.shouldAttempt()).toBe(false);
    h.a.observe(true);
    expect(h.a.shouldAttempt()).toBe(true);
    expect(h.a.status()).toEqual({
      connected: true,
      failures: 0,
      retryAt: 0,
      contactsDenied: false,
      ambiguous: [],
    });
    expect(h.logs.map((l) => l.msg)).toEqual([
      "helper offline: helper-backed sources and jobs are paused",
      "helper connected: helper-backed sources and jobs resume",
    ]);
  });

  it("does not treat a non-helper error as offline", () => {
    const h = harness(true);
    expect(h.a.noteFailure(new Error("timeout"))).toBe(false);
    expect(h.a.status().connected).toBe(true);
    expect(h.changes).toEqual([]);
  });

  it("reports the same offline transition from an observation", () => {
    const h = harness(true);
    h.a.observe(false);
    expect(h.a.shouldAttempt()).toBe(false);
    h.advance(59_999);
    expect(h.a.shouldAttempt()).toBe(false);
    h.advance(1);
    // The back-off has passed: one attempt may run (it probes the helper again).
    expect(h.a.shouldAttempt()).toBe(true);
    h.a.observe(false);
    expect(h.logs).toHaveLength(1);
  });
});

describe("HelperAvailability ambiguity", () => {
  it("reports the helpers it will not choose between, once per change", () => {
    const seen: string[][] = [];
    const a = new HelperAvailability(false, {
      now: () => 0,
      onChange: (s) => seen.push(s.ambiguous.map((h) => h.deviceId)),
    });
    const two = [
      { deviceId: "a", name: "A", pairedAt: null },
      { deviceId: "b", name: "B", pairedAt: null },
    ];
    a.setAmbiguous(two);
    a.setAmbiguous(two);
    expect(a.status().ambiguous).toEqual(two);
    a.setAmbiguous([]);
    expect(seen).toEqual([["a", "b"], []]);
  });
});

describe("HelperAvailability notifications", () => {
  it("reports every change to onChange, including the Contacts refusal", () => {
    const seen: { connected: boolean; contactsDenied: boolean }[] = [];
    const a = new HelperAvailability(true, {
      now: () => 0,
      onChange: (s) => seen.push({ connected: s.connected, contactsDenied: s.contactsDenied }),
    });
    a.noteFailure(needsHelper());
    a.observe(true);
    a.setContactsDenied(true);
    a.setContactsDenied(true);
    a.setContactsDenied(false);
    expect(seen).toEqual([
      { connected: false, contactsDenied: false },
      { connected: true, contactsDenied: false },
      { connected: true, contactsDenied: true },
      { connected: true, contactsDenied: false },
    ]);
  });
});
