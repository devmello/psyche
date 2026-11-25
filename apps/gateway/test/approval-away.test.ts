import type { IssuedApproval } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { AwayRouter } from "../src/compose/approval-away.ts";

/** The away chat (decision D3): held until the owner has been away for the window. */

const MIN = 60_000;

function rig(awayAfterMs = 10 * MIN) {
  let now = 0;
  let activity = 0;
  const open = new Set<string>(["a1"]);
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const delivered: string[] = [];
  const router = new AwayRouter({
    now: () => now,
    activityAt: () => activity,
    awayAfterMs: () => awayAfterMs,
    isOpen: async (id) => open.has(id),
    deliver: async (i) => {
      delivered.push(i.approval.id);
    },
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { live: boolean }).live = false;
    },
  });
  const issued = {
    approval: { id: "a1" },
    answerTokens: { "telegram:1": "t" },
  } as unknown as IssuedApproval;
  /** Moves the clock to `to`, firing the timers that come due, in order. */
  const advance = async (to: number) => {
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= to).sort((x, y) => x.at - y.at)[0];
      if (next === undefined) break;
      next.live = false;
      now = Math.max(now, next.at);
      next.fn();
      await new Promise((r) => setTimeout(r, 0));
    }
    now = to;
  };
  return {
    router,
    issued,
    open,
    delivered,
    advance,
    activity: (at: number) => {
      activity = at;
    },
  };
}

describe("AwayRouter", () => {
  it("an idle Mac app (socket open, no activity) gets the away chat the card at the N-minute mark", async () => {
    const r = rig();
    r.router.hold(r.issued);
    await r.advance(5 * MIN);
    expect(r.delivered).toEqual([]);
    await r.advance(10 * MIN + 1000);
    expect(r.delivered).toEqual(["a1"]);
  });

  it("activity inside the window pushes the card back; it is sent once the owner has been gone N minutes", async () => {
    const r = rig();
    r.router.hold(r.issued);
    await r.advance(8 * MIN);
    r.activity(8 * MIN);
    await r.advance(17 * MIN);
    expect(r.delivered).toEqual([]);
    await r.advance(18 * MIN + 1000);
    expect(r.delivered).toEqual(["a1"]);
  });

  it("a card answered before N minutes sends nothing", async () => {
    const r = rig();
    r.router.hold(r.issued);
    await r.advance(5 * MIN);
    r.open.delete("a1");
    await r.advance(60 * MIN);
    expect(r.delivered).toEqual([]);
  });

  it("stop() cancels what is held", async () => {
    const r = rig();
    r.router.hold(r.issued);
    r.router.stop();
    await r.advance(60 * MIN);
    expect(r.delivered).toEqual([]);
  });
});
