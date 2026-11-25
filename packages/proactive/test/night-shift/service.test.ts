import { describe, expect, it } from "vitest";
import { dailyCron } from "../../src/daily/settings.ts";
import { type GateState, NIGHT_SHIFT_MARKER } from "../../src/index.ts";
import { draftCall, GOOD, goodDraft, HOUR, mailCandidate, NIGHT_START, rig } from "./rig.ts";

/** A job that stages the one good draft into its night. */
const stagesOne =
  (r: ReturnType<typeof rig>) => async (input: { staging: { nightId: string } }) => {
    const sink = r.service.sinkFor(input.staging.nightId);
    await sink.stage(draftCall(input.staging.nightId, goodDraft));
  };

describe("Night shift: nothing to do", () => {
  it("is off until the owner turns it on: no model call, no row", async () => {
    const r = rig({ settings: { "nightShift.enabled": false }, sources: [mailCandidate("t-1")] });
    expect((await r.service.run()).outcome).toBe("off");
    expect(r.w.jobs).toHaveLength(0);
    expect(r.store.listNights()).toHaveLength(0);
  });

  it("zero candidates: no model call, no row, no notification", async () => {
    const r = rig({ sources: [] });
    expect((await r.service.run()).outcome).toBe("no_candidates");
    expect(r.w.jobs).toHaveLength(0);
    expect(r.store.listNights()).toHaveLength(0);
    expect(r.w.notices).toHaveLength(0);
    expect(r.w.holds).toBe(0);
    expect(r.service.briefLine()).toBeUndefined();
  });

  it("a source for a domain the owner turned off gives no candidates", async () => {
    const r = rig({
      settings: { "nightShift.domains.mail": false },
      sources: [mailCandidate("t-1")],
    });
    expect((await r.service.run()).outcome).toBe("no_candidates");
    expect(r.w.jobs).toHaveLength(0);
  });

  it("jobs that stage nothing store the night as empty: no review, no notification, no brief line", async () => {
    const r = rig({ sources: [mailCandidate("t-1")] });
    const out = await r.service.run();
    expect(out.outcome).toBe("empty");
    expect(r.w.jobs).toHaveLength(1);
    expect(out.night?.status).toBe("empty");
    expect(out.night?.reviewStatus).toBe("none");
    expect(r.w.notices).toHaveLength(0);
    expect(r.service.briefLine()).toBeUndefined();
  });
});

describe("Night shift: a night with items", () => {
  it("stages, notifies once, writes the brief line and holds keep-awake only for the run on AC", async () => {
    const r = rig({ sources: [mailCandidate("t-1")] });
    r.w.script = stagesOne(r);
    const out = await r.service.run();
    expect(out.outcome).toBe("done");
    expect(out.night).toMatchObject({ status: "done", reviewStatus: "ready", night: "2026-11-25" });
    expect(out.night?.expiresAt).toBe(new Date(NIGHT_START + 3 * 24 * HOUR).toISOString());
    const items = r.store.listStagedActions(out.night?.id as string);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ domain: "mail", status: "ready", taint: true });
    expect(items[0]?.why).toBe("Quiet thread: Thread t-1");
    // The job went out as a tainted staging task with the per-job budget.
    expect(r.w.jobs[0]).toMatchObject({
      staging: { kind: "night" },
      budget: { maxSteps: 8, maxTokens: 30_000, maxWallMs: 120_000 },
      taint: true,
    });
    expect(r.w.notices).toEqual([
      expect.objectContaining({ dedupeKey: "nightshift:2026-11-25", route: expect.any(String) }),
    ]);
    expect(r.w.holds).toBe(1);
    expect(r.w.releases).toBe(1);
    expect(r.service.briefLine()?.text).toBe("Night shift prepared 1 change: 1 reply draft.");
  });

  it("the brief line counts every domain with a template", async () => {
    const r = rig({ sources: [mailCandidate("t-1")] });
    r.w.script = stagesOne(r);
    await r.service.run();
    const night = r.store.listNights("ready")[0];
    // Two more ready items of other domains.
    for (const [domain, key] of [
      ["calendar", "e1"],
      ["files", "f1"],
      ["files", "f2"],
    ] as const) {
      r.store.insertStagedAction({
        nightId: night?.id as string,
        seq: 5,
        domain,
        targetKey: key,
        tool: "x",
        kind: "connector_action",
        sideEffect: "write",
        paramsHash: "h",
        bindingHash: "b",
        summary: "s",
      });
    }
    expect(r.service.briefLine()?.text).toBe(
      "Night shift prepared 4 changes: 1 reply draft, 1 calendar fix, 2 filed documents.",
    );
  });

  it("does not run twice in one night: no repeat, no catch-up", async () => {
    const r = rig({ sources: [mailCandidate("t-1")] });
    r.w.script = stagesOne(r);
    await r.service.run();
    expect((await r.service.run()).outcome).toBe("already");
    expect(r.w.jobs).toHaveLength(1);
  });

  it("on battery it runs without a keep-awake hold", async () => {
    const r = rig({
      sources: [mailCandidate("t-1")],
      state: { ...GOOD, onAc: false, batteryPct: 80 },
    });
    r.w.script = stagesOne(r);
    expect((await r.service.run()).outcome).toBe("done");
    expect(r.w.holds).toBe(0);
  });

  it("losing AC mid-run releases the hold", async () => {
    const r = rig({ sources: [mailCandidate("a"), mailCandidate("b")] });
    r.w.script = async () => {
      r.w.state = { ...GOOD, onAc: false, batteryPct: 80 };
    };
    await r.service.run();
    expect(r.w.holds).toBe(1);
    expect(r.w.releases).toBe(1);
  });
});

describe("Night shift: the budget", () => {
  it("stops new jobs when what is left is below one job's worst case", async () => {
    const r = rig({ sources: ["a", "b", "c"].map(mailCandidate) });
    r.w.script = async (input, taskId) => {
      r.service.meter(taskId, { input: 1000, output: 500, costUsd: 0.3 });
      await stagesOne(r)(input);
    };
    const out = await r.service.run();
    expect(r.w.jobs).toHaveLength(1);
    expect(out).toMatchObject({ outcome: "stopped", reason: "budget" });
    expect(out.night).toMatchObject({ status: "stopped", stopReason: "budget", tokens: 1500 });
    expect(out.night?.spentUsd).toBeCloseTo(0.3);
    // Something was prepared, so the owner is told.
    expect(r.service.briefLine()).toBeDefined();
  });

  it("a bigger budget runs more jobs (positive control)", async () => {
    const r = rig({
      sources: ["a", "b", "c"].map(mailCandidate),
      settings: { "nightShift.budgetUsd": 5 },
    });
    r.w.script = async (_i, taskId) =>
      r.service.meter(taskId, { input: 10, output: 10, costUsd: 0.3 });
    await r.service.run();
    expect(r.w.jobs).toHaveLength(3);
  });

  it("the token ceiling binds an unpriced model (cost 0)", async () => {
    const r = rig({ sources: ["a", "b"].map(mailCandidate) });
    r.w.script = async (_i, taskId) =>
      r.service.meter(taskId, { input: 380_000, output: 1000, costUsd: 0 });
    const out = await r.service.run();
    expect(r.w.jobs).toHaveLength(1);
    expect(out.night?.stopReason).toBe("tokens");
  });

  it("the cap is clamped to the $5 maximum", async () => {
    const r = rig({
      sources: ["a", "b"].map(mailCandidate),
      settings: { "nightShift.budgetUsd": 99 },
    });
    r.w.script = async (_i, taskId) =>
      r.service.meter(taskId, { input: 1, output: 1, costUsd: 4.9 });
    await r.service.run();
    expect(r.w.jobs).toHaveLength(1);
  });

  it("usage of a task that is not one of tonight's jobs is not counted", async () => {
    const r = rig({ sources: ["a", "b"].map(mailCandidate) });
    r.w.script = async () =>
      r.service.meter("some_other_task", { input: 1, output: 1, costUsd: 9 });
    await r.service.run();
    expect(r.w.jobs).toHaveLength(2);
  });
});

describe("Night shift: power, thermal and idle gates", () => {
  const BLOCKED: [string, GateState, string][] = [
    ["battery under 50%", { ...GOOD, onAc: false, batteryPct: 40 }, "battery"],
    [
      "battery unreadable",
      { onAc: false, lowPowerMode: false, thermal: "nominal", idleMinutes: 60 },
      "battery",
    ],
    [
      "Low Power Mode on battery",
      { ...GOOD, onAc: false, batteryPct: 90, lowPowerMode: true },
      "low_power",
    ],
    ["thermal serious", { ...GOOD, thermal: "serious" }, "thermal"],
    ["thermal critical", { ...GOOD, thermal: "critical" }, "thermal"],
    ["owner idle under 10 min", { ...GOOD, idleMinutes: 9 }, "not_idle"],
  ];

  it.each(BLOCKED)(
    "%s: no start, the night is recorded skipped at the window end",
    async (_l, state, reason) => {
      const r = rig({ sources: [mailCandidate("t-1")], state });
      const out = await r.service.run();
      expect(out).toMatchObject({ outcome: "skipped", reason });
      expect(r.w.jobs).toHaveLength(0);
      expect(r.w.notices).toHaveLength(0);
      expect(out.night).toMatchObject({ status: "skipped", stopReason: reason });
      // It waited inside the window and stopped at its end.
      expect(r.w.sleeps.length).toBeGreaterThan(0);
      expect(r.clock.now()).toBeLessThanOrEqual(NIGHT_START + 4 * HOUR);
    },
  );

  const OK: [string, GateState][] = [
    ["AC power", GOOD],
    ["battery at 50% not in Low Power Mode", { ...GOOD, onAc: false, batteryPct: 50 }],
    ["thermal fair", { ...GOOD, thermal: "fair" }],
    ["idle exactly 10 min", { ...GOOD, idleMinutes: 10 }],
  ];
  it.each(OK)("%s starts", async (_l, state) => {
    const r = rig({ sources: [mailCandidate("t-1")], state });
    await r.service.run();
    expect(r.w.jobs).toHaveLength(1);
  });

  it("a gate that clears inside the window starts then (plugged in at 2 am)", async () => {
    const r = rig({
      sources: [mailCandidate("t-1")],
      state: { ...GOOD, onAc: false, batteryPct: 30 },
    });
    r.w.onSleep = () => {
      r.w.state = GOOD;
    };
    await r.service.run();
    expect(r.w.jobs).toHaveLength(1);
    expect(r.w.sleeps).toHaveLength(1);
  });

  const BETWEEN: [string, GateState, string][] = [
    ["battery under 30%", { ...GOOD, onAc: false, batteryPct: 29 }, "battery_low"],
    ["Low Power Mode", { ...GOOD, lowPowerMode: true }, "low_power"],
    ["thermal serious", { ...GOOD, thermal: "serious" }, "thermal"],
  ];
  it.each(BETWEEN)("between jobs: %s stops the night", async (_l, state, reason) => {
    const r = rig({ sources: ["a", "b"].map(mailCandidate) });
    r.w.script = async (input) => {
      await stagesOne(r)(input);
      r.w.state = state;
    };
    const out = await r.service.run();
    expect(r.w.jobs).toHaveLength(1);
    expect(out).toMatchObject({ outcome: "stopped", reason });
  });

  it("between jobs: fair thermal and 30% on battery keep going (positive control)", async () => {
    const r = rig({ sources: ["a", "b"].map(mailCandidate) });
    r.w.script = async () => {
      r.w.state = { ...GOOD, onAc: false, batteryPct: 30, thermal: "fair" };
    };
    await r.service.run();
    expect(r.w.jobs).toHaveLength(2);
  });

  it("the owner at the keyboard pauses the run until idle again, inside the window", async () => {
    const r = rig({ sources: ["a", "b"].map(mailCandidate) });
    r.w.script = async () => {
      r.w.state = { ...GOOD, idleMinutes: 1 };
    };
    r.w.onSleep = () => {
      r.w.state = GOOD;
    };
    await r.service.run();
    expect(r.w.jobs).toHaveLength(2);
    expect(r.w.sleeps).toHaveLength(1);
  });

  it("an owner who stays active to the window end stops the night", async () => {
    const r = rig({ sources: ["a", "b"].map(mailCandidate) });
    r.w.script = async () => {
      r.w.state = { ...GOOD, idleMinutes: 1 };
    };
    const out = await r.service.run();
    expect(r.w.jobs).toHaveLength(1);
    expect(out.night?.stopReason).toBe("owner_active");
  });

  it("an unreadable machine state is not safe", async () => {
    const r = rig({ sources: [mailCandidate("t-1")] });
    r.w.state = undefined as never;
    const out = await r.service.run();
    expect(out.outcome).toBe("skipped");
    expect(r.w.jobs).toHaveLength(0);
  });
});

describe("Night shift: the window and a sleeping Mac", () => {
  it("slept through the whole window: the night is skipped and recorded, with no catch-up", async () => {
    // The Mac wakes at 07:00, past 05:00: the scheduler's coalesced tick calls run().
    const r = rig({ start: NIGHT_START + 6 * HOUR, sources: [mailCandidate("t-1")] });
    const out = await r.service.run();
    expect(out).toMatchObject({ outcome: "skipped", reason: "asleep" });
    expect(out.night).toMatchObject({
      night: "2026-11-25",
      status: "skipped",
      stopReason: "asleep",
    });
    expect(r.w.jobs).toHaveLength(0);
    expect(r.w.notices).toHaveLength(0);
    expect(r.w.holds).toBe(0);
    // Asking again later in the day does not catch up.
    r.clock.advance(3 * HOUR);
    expect((await r.service.run()).outcome).toBe("already");
    expect(r.w.jobs).toHaveLength(0);
    // The next night runs as usual.
    r.clock.set(NIGHT_START + 24 * HOUR);
    r.w.script = stagesOne(r);
    expect((await r.service.run()).outcome).toBe("done");
    expect(r.store.getNightByDate("2026-11-26")?.status).toBe("done");
  });

  it("a wake inside the window runs", async () => {
    const r = rig({ start: NIGHT_START + 2 * HOUR, sources: [mailCandidate("t-1")] });
    r.w.script = stagesOne(r);
    expect((await r.service.run()).outcome).toBe("done");
  });

  it("stops between jobs at the window end", async () => {
    const r = rig({ sources: ["a", "b"].map(mailCandidate) });
    r.w.script = async () => r.clock.advance(5 * HOUR);
    const out = await r.service.run();
    expect(r.w.jobs).toHaveLength(1);
    expect(out.night?.stopReason).toBe("window_end");
  });

  it("the window follows the live zone and the settings", async () => {
    const r = rig({
      start: Date.parse("2026-11-25T03:30:00Z"),
      sources: [mailCandidate("t-1")],
      settings: { "nightShift.window.start": "03:00", "nightShift.window.end": "04:00" },
    });
    r.w.script = stagesOne(r);
    expect((await r.service.run()).outcome).toBe("done");
    // A window shorter than an hour falls back to the default.
    const bad = rig({
      settings: { "nightShift.window.start": "03:00", "nightShift.window.end": "03:30" },
    });
    expect(bad.service).toBeDefined();
  });

  it("the automation is a cron at the window start in the live zone; the job matches its marker", async () => {
    const r = rig();
    expect(r.service.job().matches({ prompt: NIGHT_SHIFT_MARKER, kind: "cron" })).toBe(true);
    expect(r.service.job().matches({ prompt: "[psyche:other start]", kind: "cron" })).toBe(false);
    expect(dailyCron("01:00")).toBe("0 1 * * *");
  });
});

describe("Night shift: restart", () => {
  it("is marked to run again after an interruption", () => {
    expect(rig().service.job().rerunOnInterrupt).toBe(true);
  });

  it("resumes the remaining candidates, cancels the orphan task and keeps the spend", async () => {
    const r = rig({
      sources: ["a", "b", "c"].map(mailCandidate),
      settings: { "nightShift.budgetUsd": 5 },
    });
    const cand = (key: string, state: string, taskId?: string) => ({
      ...(mailCandidate(key).list(0) as { id: string }[])[0],
      state,
      ...(taskId === undefined ? {} : { taskId }),
    });
    r.store.insertNight({
      night: "2026-11-25",
      status: "running",
      candidates: {
        items: [
          cand("a", "done", "task_old1"),
          cand("b", "running", "task_old2"),
          cand("c", "pending"),
        ],
      },
      spentUsd: 0.2,
      tokens: 1234,
      startedAt: new Date(NIGHT_START).toISOString(),
    });
    r.clock.advance(HOUR);
    r.w.script = stagesOne(r);
    const out = await r.service.run();
    expect(r.w.cancelled).toEqual(["task_old2"]);
    // Only b and c ran again; a had finished before the restart.
    expect(r.w.jobs.map((j) => j.title)).toEqual([
      "Night shift: Thread b",
      "Night shift: Thread c",
    ]);
    expect(out.outcome).toBe("done");
    expect(out.night?.tokens).toBe(1234);
    expect(out.night?.spentUsd).toBeCloseTo(0.2);
    expect(r.store.listNights()).toHaveLength(1);
  });

  it("a restart does not turn a finished night into a second one", async () => {
    const r = rig({ sources: [mailCandidate("a")] });
    r.w.script = stagesOne(r);
    await r.service.run();
    expect((await r.service.run()).outcome).toBe("already");
    expect(r.w.jobs).toHaveLength(1);
  });
});

describe("Night shift: expiry", () => {
  it("clears params and previews of unreviewed items after the expiry, keeps the counts", async () => {
    const r = rig({ sources: [mailCandidate("t-1")] });
    r.w.script = stagesOne(r);
    const out = await r.service.run();
    r.clock.advance(4 * 24 * HOUR);
    expect(r.service.sweepExpired()).toBe(1);
    const item = r.store.listStagedActions(out.night?.id as string)[0];
    expect(item).toMatchObject({ status: "expired", params: null, preview: null });
    expect(r.store.getNight(out.night?.id as string)?.reviewStatus).toBe("expired");
    expect(r.service.briefLine()).toBeUndefined();
  });
});
