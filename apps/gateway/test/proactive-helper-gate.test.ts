import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { HelperAvailability } from "../src/compose/helper-availability.ts";
import { helperGated } from "../src/compose/proactive.ts";

const needsHelper = () =>
  new PsycheError("unavailable", "Apple Mail needs the Psyche helper on your Mac", {
    details: { reason: "needs_helper" },
    retryable: true,
  });

function job(run: () => Promise<unknown>) {
  let calls = 0;
  return {
    calls: () => calls,
    job: {
      name: "mail-watch",
      matches: () => false,
      run: async () => {
        calls += 1;
        return (await run()) as never;
      },
    } as never,
  };
}

function setup(connected: () => boolean) {
  let t = 1_000_000;
  const state = new HelperAvailability(connected(), { now: () => t, baseMs: 60_000 });
  return {
    state,
    helper: { state, connected },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("helperGated proactive jobs", () => {
  it("runs the job as before when the helper is connected", async () => {
    const s = setup(() => true);
    const j = job(async () => ({ status: "done" }));
    const out = await helperGated(j.job, s.helper).run({} as never);
    expect(out).toEqual({ status: "done" });
    expect(j.calls()).toBe(1);
  });

  it("skips quietly while the helper is offline and inside the back-off", async () => {
    const online = false;
    const s = setup(() => online);
    const j = job(async () => {
      throw needsHelper();
    });
    const gated = helperGated(j.job, s.helper);
    // First run: the helper is offline, so the job is attempted once and fails with needs-helper.
    await expect(gated.run({} as never)).rejects.toThrow(/needs the Psyche helper/);
    expect(j.calls()).toBe(1);
    expect(s.state.status().connected).toBe(false);
    // Inside the back-off the job does not run at all.
    s.advance(30_000);
    expect(await gated.run({} as never)).toEqual({
      status: "no_reply",
      summary: "helper offline",
    });
    expect(j.calls()).toBe(1);
  });

  it("runs again once the back-off passes, and at once on reconnect", async () => {
    let online = false;
    const s = setup(() => online);
    const j = job(async () => {
      if (!online) throw needsHelper();
      return { status: "done" };
    });
    const gated = helperGated(j.job, s.helper);
    await expect(gated.run({} as never)).rejects.toThrow();
    s.advance(60_000);
    await expect(gated.run({} as never)).rejects.toThrow();
    expect(j.calls()).toBe(2);
    online = true;
    expect(await gated.run({} as never)).toEqual({ status: "done" });
    expect(j.calls()).toBe(3);
  });

  it("leaves other failures to the caller and does not back off", async () => {
    const s = setup(() => true);
    const j = job(async () => {
      throw new PsycheError("internal", "boom");
    });
    await expect(helperGated(j.job, s.helper).run({} as never)).rejects.toThrow("boom");
    expect(s.state.status().failures).toBe(0);
    expect(s.state.status().connected).toBe(true);
  });

  it("returns the job unchanged when no helper state is given", () => {
    const j = job(async () => ({ status: "done" }));
    expect(helperGated(j.job, undefined)).toBe(j.job);
  });
});
