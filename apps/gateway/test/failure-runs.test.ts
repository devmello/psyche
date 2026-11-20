import { describe, expect, it } from "vitest";
import { failureRuns } from "../src/failure-runs.ts";

describe("failureRuns", () => {
  it("logs the first failure of a run, then stays quiet until an hour has passed", () => {
    let now = 0;
    const runs = failureRuns({ now: () => now, everyMs: 3_600_000 });
    expect(runs.fail("mail", "needs the helper")).toEqual({ log: true, repeats: 0 });
    now += 60_000;
    expect(runs.fail("mail", "needs the helper").log).toBe(false);
    now += 60_000;
    expect(runs.fail("mail", "needs the helper").log).toBe(false);
    now = 3_600_000;
    expect(runs.fail("mail", "needs the helper")).toEqual({ log: true, repeats: 3 });
  });

  it("logs a new run in full when the error text changes", () => {
    const runs = failureRuns({ now: () => 0 });
    runs.fail("notes", "needs the helper");
    expect(runs.fail("notes", "timed out")).toEqual({ log: true, repeats: 0 });
  });

  it("keeps sources apart", () => {
    const runs = failureRuns({ now: () => 0 });
    runs.fail("mail", "needs the helper");
    expect(runs.fail("calendar", "needs the helper").log).toBe(true);
  });

  it("logs the next failure in full after a success ends the run", () => {
    const runs = failureRuns({ now: () => 0 });
    runs.fail("mail", "needs the helper");
    expect(runs.fail("mail", "needs the helper").log).toBe(false);
    runs.ok("mail");
    expect(runs.fail("mail", "needs the helper")).toEqual({ log: true, repeats: 0 });
  });
});
