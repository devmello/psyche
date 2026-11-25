import type { ModelEvent, PointsDigest, PointsField } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { SecretRedactor } from "@psyche/vault";
import { describe, expect, it } from "vitest";
import {
  type PointsCheckedStep,
  type PointsPlanCallDeps,
  requestPointsPlan,
} from "../src/compose/points-plan.ts";
import {
  meetsExpectation,
  POINTS_BUDGET_LIMITS,
  POINTS_PAGES_MAX,
  PointsBudget,
  PointsStepTracker,
} from "../src/compose/points-steps.ts";

const STRINGS = {
  selfFill: "You fill this yourself: {label}",
  selfFillPlain: "You fill this yourself",
  payButton: "This button pays.",
  unknownValue: "Psyche doesn't know this one.",
};

function field(id: string, label: string, extra: Partial<PointsField> = {}): PointsField {
  return { fieldId: id, role: "text", label, path: [], state: "empty", ...extra };
}

function page(fp: string, fields: PointsField[], title = `Page ${fp}`): PointsDigest {
  return {
    app: { bundleId: "com.apple.Safari", name: "Safari" },
    windowTitle: title,
    host: "forms.example.gov",
    path: "/form",
    headings: [],
    instructions: "",
    fingerprint: fp,
    fields,
    tree: "ok",
  };
}

const PAGE_A = () =>
  page("A", [
    field("f1", "Legal name"),
    field("f2", "Date of birth", { role: "date" }),
    field("f3", "Nickname"),
    field("f4", "Email"),
    field("f5", "Continue", { role: "button" }),
  ]);
const PAGE_B = () => page("B", [field("f10", "Street"), field("f11", "Next", { role: "button" })]);

const reply = (plan: unknown, input = 1000): ModelEvent[] => [
  { type: "text_delta", text: JSON.stringify(plan) },
  {
    type: "usage",
    usage: { input, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

const PLAN_A = {
  page: { title: "Part 1", summary: "You" },
  steps: [
    { fieldId: "f5", kind: "next_page", note: "Go on" },
    {
      fieldId: "f1",
      kind: "fill",
      note: "Your name",
      value: "Ada Lovelace",
      sources: ["profile:name"],
    },
    { fieldId: "f3", kind: "skip", note: "Leave blank" },
    { fieldId: "f2", kind: "fill", note: "Birth date", expect: { shape: "date" } },
    { fieldId: "f4", kind: "fill", note: "Email", expect: { shape: "email" } },
  ],
  done_when: "next_page",
};
const PLAN_B = {
  page: { title: "Part 2", summary: "Where" },
  steps: [
    { fieldId: "f10", kind: "fill", note: "Street" },
    { fieldId: "f11", kind: "review", note: "Review" },
  ],
  done_when: "submit",
};

function rig(plans: unknown[] = []) {
  const provider = new FakeModelProvider();
  provider.script(plans.map((p) => reply(p)));
  const deps: PointsPlanCallDeps = {
    provider,
    model: "fake/model",
    redactor: new SecretRedactor(),
  };
  const tracker = new PointsStepTracker();
  const memory = [{ id: "profile:name", text: "The owner's name is Ada Lovelace.", trusted: true }];

  /** What W7 does for one digest: observe, and make a plan call only when the gate says so. */
  async function show(d: PointsDigest) {
    const change = tracker.observe(d);
    const gate = tracker.beginPlan(1500);
    if (!gate.ok) return { change, gate, called: false };
    const r = await requestPointsPlan(deps, {
      digest: d,
      memory,
      earlierPages: tracker.earlierPages(),
      strings: STRINGS,
    });
    if (r.ok) tracker.completePlan(d.fingerprint, r.plan, r.usage);
    else tracker.failPlan(d.fingerprint, r.usage);
    return { change, gate, called: true };
  }
  return { provider, tracker, show };
}

const stepOf = (t: ReturnType<PointsStepTracker["target"]>): PointsCheckedStep => {
  if (t.type !== "step") throw new Error(`no step: ${t.type}`);
  return t.step;
};

describe("budget caps", () => {
  it.each([
    ["30th call is allowed", { calls: 29, tokens: 0 }, 0, true],
    ["31st call is refused", { calls: 30, tokens: 0 }, 0, false],
    ["calls under the cap, tokens at it", { calls: 3, tokens: 300_000 }, 0, false],
    ["tokens just under the cap", { calls: 3, tokens: 299_999 }, 0, true],
    ["a request that would step over the token cap", { calls: 3, tokens: 295_000 }, 6000, false],
    ["a request that just fits", { calls: 3, tokens: 295_000 }, 5000, true],
  ])("%s", (_name, used, estimate, ok) => {
    const b = new PointsBudget();
    for (let i = 0; i < used.calls; i += 1) expect(b.begin(0).ok).toBe(true);
    b.settle(used.tokens);
    expect(b.begin(estimate).ok).toBe(ok);
  });

  it("says which cap stopped it", () => {
    const calls = new PointsBudget({ maxCalls: 1 });
    calls.begin(0);
    expect(calls.begin(0)).toEqual({ ok: false, reason: "calls" });
    const tokens = new PointsBudget();
    tokens.begin(0);
    tokens.settle(POINTS_BUDGET_LIMITS.maxInputTokens);
    expect(tokens.begin(0)).toEqual({ ok: false, reason: "tokens" });
    expect(tokens.exhausted()).toBe("tokens");
  });

  it("ignores a bad token count and never goes backwards", () => {
    const b = new PointsBudget();
    b.settle(100);
    b.settle(-50);
    b.settle(Number.NaN);
    expect(b.inputTokens).toBe(100);
  });

  it("stops plan calls at the cap but keeps pointing from the last plan", async () => {
    const provider = new FakeModelProvider();
    provider.script([reply(PLAN_A)]);
    const deps: PointsPlanCallDeps = {
      provider,
      model: "fake/model",
      redactor: new SecretRedactor(),
    };
    const t = new PointsStepTracker({ budget: new PointsBudget({ maxCalls: 1 }) });
    t.observe(PAGE_A());
    expect(t.beginPlan(0)).toEqual({ ok: true });
    const r = await requestPointsPlan(deps, { digest: PAGE_A(), strings: STRINGS });
    if (r.ok) t.completePlan("A", r.plan, r.usage);
    // A new page at the cap: no call, no plan for it.
    t.observe(PAGE_B());
    expect(t.beginPlan(0)).toEqual({ ok: false, reason: "calls" });
    expect(t.target()).toEqual({ type: "no_plan" });
    // The owner goes back to page A: its last plan still points.
    t.observe(PAGE_A());
    expect(stepOf(t.target()).fieldId).toBe("f1");
    expect(provider.requests).toHaveLength(1);
  });

  it("counts the provider's input tokens from each finished call", async () => {
    const provider = new FakeModelProvider();
    provider.script([reply(PLAN_A, 120_000), reply(PLAN_B, 120_000), reply(PLAN_A, 120_000)]);
    const deps: PointsPlanCallDeps = {
      provider,
      model: "fake/model",
      redactor: new SecretRedactor(),
    };
    const t = new PointsStepTracker();
    let calls = 0;
    for (const d of [PAGE_A(), PAGE_B(), page("C", [field("f20", "Other")])]) {
      t.observe(d);
      const g = t.beginPlan(1000);
      if (!g.ok) continue;
      calls += 1;
      const r = await requestPointsPlan(deps, { digest: d, strings: STRINGS });
      if (r.ok) t.completePlan(d.fingerprint, r.plan, r.usage);
    }
    // 240k used after two calls; the third page's call (est. 1000) still fits, a fourth would not.
    expect(calls).toBe(3);
    expect(t.budget.inputTokens).toBe(360_000);
    t.observe(page("D", [field("f30", "More")]));
    expect(t.beginPlan(0)).toEqual({ ok: false, reason: "tokens" });
  });
});

describe("multi-page replay", () => {
  it("makes one call per new page and none for a page seen again", async () => {
    const r = rig([PLAN_A, PLAN_B]);
    expect((await r.show(PAGE_A())).called).toBe(true);
    expect((await r.show(PAGE_B())).called).toBe(true);
    expect(r.provider.requests).toHaveLength(2);
    // The owner presses the form's own Back: page A again.
    const back = await r.show(PAGE_A());
    expect(back).toMatchObject({ called: false, change: "returned" });
    expect(back.gate).toEqual({ ok: false, reason: "has_plan" });
    expect(r.provider.requests).toHaveLength(2);
    expect(r.provider.remainingTurns).toBe(0);
    // And forward again, and back once more: still two calls in all.
    await r.show(PAGE_B());
    await r.show(PAGE_A());
    expect(r.provider.requests).toHaveLength(2);
    expect(stepOf(r.tracker.target()).fieldId).toBe("f1");
  });

  it("does not call again for a re-read of the same page", async () => {
    const r = rig([PLAN_A]);
    await r.show(PAGE_A());
    const again = await r.show(PAGE_A());
    expect(again).toMatchObject({ called: false, change: "same" });
    expect(r.provider.requests).toHaveLength(1);
  });

  it("sends the earlier pages as titles and counts only", async () => {
    const r = rig([PLAN_A, PLAN_B]);
    const a = PAGE_A();
    a.fields[0] = field("f1", "Legal name", { value: "Ada Lovelace", state: "filled" });
    await r.show(a);
    await r.show(PAGE_B());
    const second = JSON.stringify(r.provider.requests[1]?.messages);
    expect(second).toContain("earlierPages");
    expect(second).toContain('\\"title\\":\\"Page A\\",\\"fields\\":5');
    expect(second).not.toContain('Ada Lovelace\\"}');
    expect(r.tracker.earlierPages()).toEqual([{ title: "Page A", fields: 5 }]);
  });

  it("stops asking about a page whose plan keeps failing", async () => {
    const provider = new FakeModelProvider();
    provider.script([
      [{ type: "text_delta", text: "nope" }],
      [{ type: "text_delta", text: "nope" }],
    ]);
    const deps: PointsPlanCallDeps = {
      provider,
      model: "fake/model",
      redactor: new SecretRedactor(),
    };
    const t = new PointsStepTracker();
    const d = PAGE_A();
    let calls = 0;
    for (let i = 0; i < 6; i += 1) {
      t.observe(d);
      if (!t.beginPlan(100).ok) continue;
      calls += 1;
      const r = await requestPointsPlan(deps, { digest: d, strings: STRINGS });
      if (!r.ok) t.failPlan(d.fingerprint, r.usage);
    }
    expect(calls).toBe(2);
    expect(t.beginPlan(0)).toEqual({ ok: false, reason: "failed" });
    expect(t.target()).toEqual({ type: "no_plan" });
  });

  it("allows only one call in flight for a page", () => {
    const t = new PointsStepTracker();
    expect(t.beginPlan(0)).toEqual({ ok: false, reason: "no_page" });
    t.observe(PAGE_A());
    expect(t.beginPlan(0)).toEqual({ ok: true });
    expect(t.beginPlan(0)).toEqual({ ok: false, reason: "in_flight" });
  });

  it("keeps at most 50 pages and never drops the one on screen", () => {
    const t = new PointsStepTracker();
    for (let i = 0; i < POINTS_PAGES_MAX + 10; i += 1) t.observe(page(`p${i}`, [field("f1", "x")]));
    expect(t.observe(page("p0", [field("f1", "x")]))).toBe("new");
    expect(t.observe(page(`p${POINTS_PAGES_MAX + 9}`, [field("f1", "x")]))).toBe("returned");
  });
});

describe("moving on", () => {
  async function started() {
    const r = rig([PLAN_A]);
    await r.show(PAGE_A());
    return r.tracker;
  }

  it("walks the plan in order, passes `skip` in passing and puts next_page last", async () => {
    const t = await started();
    const first = t.target();
    expect(first).toMatchObject({ type: "step", n: 1, total: 4 });
    expect(stepOf(first).fieldId).toBe("f1");
    expect(t.commit("f1", { changed: true, value: "Ada Lovelace" })).toEqual({ moved: true });
    // f3 is a skip step: it rides along with the next target and is not waited on.
    const second = t.target();
    expect(stepOf(second).fieldId).toBe("f2");
    expect(second.type === "step" && second.passing.map((s) => s.fieldId)).toEqual(["f3"]);
    t.commit("f2", { changed: true, value: "10 December 1815" });
    t.commit("f4", { changed: true, value: "ada@example.com" });
    expect(stepOf(t.target()).fieldId).toBe("f5");
    expect(stepOf(t.target()).kind).toBe("next_page");
    t.skip();
    expect(t.target()).toEqual({ type: "finished", total: 4 });
  });

  it("moves when focus lands on the planned next field, not on any other", async () => {
    const t = await started();
    expect(t.focus("f4")).toBe(false);
    expect(t.focus("f99")).toBe(false);
    expect(stepOf(t.target()).fieldId).toBe("f1");
    expect(t.focus("f3")).toBe(false); // a skip step is not a target
    expect(t.focus("f2")).toBe(true);
    expect(stepOf(t.target()).fieldId).toBe("f2");
    expect(t.focus("f2")).toBe(false);
  });

  it("does not move when the target loses focus with nothing new", async () => {
    const t = await started();
    expect(t.commit("f1", { changed: false })).toEqual({ moved: false });
    expect(stepOf(t.target()).fieldId).toBe("f1");
  });

  it("passes a later field that was filled out of order", async () => {
    const t = await started();
    expect(t.commit("f4", { changed: true, value: "ada@example.com" })).toEqual({ moved: false });
    t.commit("f1", { changed: true, value: "Ada Lovelace" });
    t.commit("f2", { changed: true, value: "10 December 1815" });
    expect(stepOf(t.target()).fieldId).toBe("f5");
  });

  it("goes back to the previous waited-on step and skips by hand", async () => {
    const t = await started();
    expect(t.back()).toBe(false);
    t.skip();
    expect(stepOf(t.target()).fieldId).toBe("f2");
    expect(t.back()).toBe(true);
    expect(stepOf(t.target()).fieldId).toBe("f1");
    t.skip();
    t.skip();
    t.skip();
    t.skip();
    expect(t.target().type).toBe("finished");
    expect(t.skip()).toBe(false);
    expect(t.back()).toBe(true);
    expect(stepOf(t.target()).fieldId).toBe("f5");
  });

  it("does not wait on a field the form already holds a value in", async () => {
    const r = rig([PLAN_A]);
    const d = PAGE_A();
    d.fields[0] = field("f1", "Legal name", { state: "filled", value: "Ada Lovelace" });
    await r.show(d);
    expect(stepOf(r.tracker.target()).fieldId).toBe("f2");
  });

  it("has no target before a plan arrives", () => {
    const t = new PointsStepTracker();
    t.observe(PAGE_A());
    expect(t.target()).toEqual({ type: "no_plan" });
    expect(t.focus("f1")).toBe(false);
    expect(t.skip()).toBe(false);
  });

  it("keeps a sensitive step as a target and never compares a value for it", async () => {
    const r = rig([
      {
        page: { title: "t", summary: "s" },
        steps: [
          { fieldId: "f1", kind: "self", note: "x" },
          { fieldId: "f2", kind: "fill", note: "Name" },
        ],
        done_when: "none",
      },
    ]);
    await r.show(page("S", [field("f1", "Social Security number"), field("f2", "Name")]));
    const step = stepOf(r.tracker.target());
    expect(step.sensitive).toBe("identity");
    expect(r.tracker.commit("f1", { changed: true, value: "123-45-6789" })).toEqual({
      moved: true,
    });
    expect(r.tracker.pendingMismatch).toBeUndefined();
  });
});

describe("expectations", () => {
  const ok = (shape: string, value: string, detail?: string, options?: string[]) =>
    meetsExpectation({ shape, detail, options } as never, value);

  it.each([
    ["date", "10 December 1815"],
    ["date", "1815-12-10"],
    ["date", "12/10/1815"],
    ["email", "ada@example.com"],
    ["phone", "+1 (415) 555-0101"],
    ["phone", "415.555.0101"],
    ["postal", "94107"],
    ["postal", "SW1A 1AA"],
    ["postal", "94107-1234"],
  ])("accepts %s %s", (shape, value) => {
    expect(ok(shape, value)).toBe(true);
  });

  it.each([
    ["date", "soon"],
    ["date", "10 December 1815 and 11 December 1815"],
    ["date", ""],
    ["email", "ada at example"],
    ["email", "ada@example"],
    ["phone", "12345"],
    ["phone", "call me maybe"],
    ["postal", "hello"],
    ["postal", "1"],
  ])("rejects %s %s", (shape, value) => {
    expect(ok(shape, value)).toBe(false);
  });

  it("checks a digit count named in the detail, and any digits without one", () => {
    expect(ok("digits", "123456789", "9 digits")).toBe(true);
    expect(ok("digits", "12345678", "9 digits")).toBe(false);
    expect(ok("digits", "123 456 789", "9 digits")).toBe(true);
    expect(ok("digits", "12a456789", "9 digits")).toBe(false);
    expect(ok("digits", "42", "how many")).toBe(true);
  });

  it("checks a oneOf against the field's options, ignoring case and spacing", () => {
    const options = ["Single", "Married filing jointly"];
    expect(ok("oneOf", "married  FILING jointly", undefined, options)).toBe(true);
    expect(ok("oneOf", "Widowed", undefined, options)).toBe(false);
    expect(ok("oneOf", "Single")).toBe(false);
  });
});

describe("mistakes", () => {
  async function started() {
    const r = rig([PLAN_A]);
    await r.show(PAGE_A());
    return r.tracker;
  }

  it("holds the target and returns the mismatch when a value misses the expectation", async () => {
    const t = await started();
    t.commit("f1", { changed: true, value: "Ada Lovelace" });
    const r = t.commit("f2", { changed: true, value: "soon" });
    expect(r).toEqual({
      moved: false,
      mismatch: { type: "shape", fieldId: "f2", shape: "date" },
    });
    expect(stepOf(t.target()).fieldId).toBe("f2");
    expect(t.pendingMismatch).toBeDefined();
  });

  it("moves on after Keep it, and stays after Show me", async () => {
    const t = await started();
    t.commit("f1", { changed: true, value: "Ada Lovelace" });
    t.commit("f2", { changed: true, value: "soon" });
    expect(t.showMe()).toMatchObject({ type: "shape" });
    expect(t.pendingMismatch).toBeUndefined();
    expect(stepOf(t.target()).fieldId).toBe("f2");
    t.commit("f2", { changed: true, value: "soon" });
    expect(t.keep()).toBe(true);
    expect(stepOf(t.target()).fieldId).toBe("f4");
    expect(t.keep()).toBe(false);
  });

  it("moves on with a value that meets it (positive control)", async () => {
    const t = await started();
    t.commit("f1", { changed: true, value: "Ada Lovelace" });
    expect(t.commit("f2", { changed: true, value: "10 December 1815" })).toEqual({ moved: true });
  });

  it("checks against the suggested value when there is no expectation", async () => {
    const t = await started();
    expect(t.commit("f1", { changed: true, value: "Ada  LOVELACE" })).toEqual({ moved: true });
    const t2 = await started();
    expect(t2.commit("f1", { changed: true, value: "Grace Hopper" })).toEqual({
      moved: false,
      mismatch: { type: "value", fieldId: "f1", suggested: "Ada Lovelace" },
    });
  });

  it("quotes a form error once per text, plain and cut, and never on a sensitive field", async () => {
    const r = rig([
      {
        page: { title: "t", summary: "s" },
        steps: [
          { fieldId: "f1", kind: "self", note: "x" },
          { fieldId: "f2", kind: "fill", note: "Name" },
        ],
        done_when: "none",
      },
    ]);
    await r.show(page("S", [field("f1", "Social Security number"), field("f2", "Name")]));
    const t = r.tracker;
    expect(t.invalid("f1", "123-45-6789 is not a valid number")).toBeUndefined();
    const q = t.invalid(
      "f2",
      `See https://evil.example/x or a@evil.example. ${"very ".repeat(80)}`,
    );
    expect(q?.fieldId).toBe("f2");
    expect(q?.quote.length).toBeLessThanOrEqual(200);
    expect(q?.quote).not.toMatch(/evil/u);
    expect(
      t.invalid("f2", `See https://evil.example/x or a@evil.example. ${"very ".repeat(80)}`),
    ).toBeUndefined();
    expect(t.invalid("f2", "Required")).toEqual({ fieldId: "f2", quote: "Required" });
    expect(t.invalid("f2", "   ")).toBeUndefined();
  });
});

describe("quoting a form error", () => {
  it("never quotes a sensitive field that has no step in the plan", async () => {
    const r = rig([
      {
        page: { title: "t", summary: "s" },
        steps: [{ fieldId: "f1", kind: "fill", note: "Name" }],
        done_when: "none",
      },
    ]);
    await r.show(page("S", [field("f1", "Name"), field("f2", "Social Security number")]));
    expect(r.tracker.invalid("f2", "Password hunter2 too short")).toBeUndefined();
    expect(r.tracker.invalid("f1", "Required")).toEqual({ fieldId: "f1", quote: "Required" });
  });

  it("never quotes a field it does not know", async () => {
    const r = rig([PLAN_A]);
    await r.show(PAGE_A());
    expect(r.tracker.invalid("f99", "Required")).toBeUndefined();
  });

  it("keeps a field sensitive once it was judged so, even if a later read says otherwise", async () => {
    const r = rig([PLAN_A]);
    await r.show(page("S", [field("f2", "Social Security number")]));
    r.tracker.observe(page("S", [field("f2", "Number")]));
    expect(r.tracker.invalid("f2", "Required")).toBeUndefined();
  });
});

describe("the call estimate is required", () => {
  it("cannot be left out", () => {
    const t = new PointsStepTracker();
    t.observe(PAGE_A());
    // @ts-expect-error the estimate has no default
    t.beginPlan();
    // @ts-expect-error the estimate has no default
    new PointsBudget().begin();
  });
});
