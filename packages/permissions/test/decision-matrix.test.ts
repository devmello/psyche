import type { GrantScope, PermissionMode, SideEffect } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  type ActionClassifier,
  allowedScopes,
  type ClassifierInput,
  type ClassifierLabel,
  type HookResult,
  type PolicyCall,
  type PolicyContext,
  type PolicyDecision,
  type PolicyHook,
} from "../src/index.ts";
import { approve, CTX, call, type Harness, makeBroker, origin } from "./helpers.ts";

/**
 * Decision matrix (S05 plan, tests): permission mode × side-effect class × taint × standing grant,
 * with the expected decision derived from the security doc rather than from the engine:
 * §3.2 (mode table), §3.3 (evaluation order), §3.4 (scopes), §3.6 (taint), §3.8 (classifier).
 *
 * The tool is a neutral connector action (`conn.action`, kind `connector_action`) with no
 * side-effect floor, so the declared class is the effective one.
 */

const TOOL = "conn.action";
const SHOP = "https://shop.example.com";
const BANK = "https://www.chase.com";
const HASH = /^sha256:[0-9a-f]{64}$/;

const MODES: PermissionMode[] = ["plan", "manual", "balanced", "auto"];
const CLASSES: SideEffect[] = ["none", "read", "write", "destructive", "financial"];
const SEVERITY: Record<SideEffect, number> = {
  none: 0,
  read: 1,
  write: 2,
  destructive: 3,
  financial: 4,
};
const ALL: GrantScope[] = ["once", "task", "site", "session", "always"];

/**
 * What the Task has already done with this exact call before the decision under test:
 * - `none`: nothing (the target is new to the Task);
 * - `touched` (read only): the owner approved one read of this origin (`once`), so it is touched;
 * - `grant`: the owner approved with the strongest scope the class allows (§3.4): `always` for
 *   read / write / destructive / financial (the owner's confirmed Always allow, §3.12).
 */
type Prior = "none" | "touched" | "grant";

interface Case {
  mode: PermissionMode;
  se: SideEffect;
  taint: boolean;
  prior: Prior;
}

const PRIORS: Record<SideEffect, Prior[]> = {
  none: ["none"], // never asks, so no grant can be created
  read: ["none", "touched", "grant"],
  write: ["none", "grant"],
  destructive: ["none", "grant"],
  financial: ["none", "grant"],
};

const GRANT_SCOPE: Record<SideEffect, GrantScope> = {
  none: "once",
  read: "always",
  write: "always",
  destructive: "always",
  financial: "always", // §3.4, §3.12: financial only `once` or a confirmed `always`
};

const CASES: Case[] = MODES.flatMap((mode) =>
  CLASSES.flatMap((se) =>
    [false, true].flatMap((taint) => PRIORS[se].map((prior) => ({ mode, se, taint, prior }))),
  ),
);

const caseName = (c: Case) =>
  `${c.mode} × ${c.se} × ${c.taint ? "tainted(newTarget)" : "untainted"} × prior:${c.prior}`;

interface Expected {
  decision: "allow" | "ask" | "deny";
  /** Exact rule, or a prefix ending in ":" (e.g. `grant:`). */
  rule: string;
  /** Exact scopes offered (asks only). */
  scopes?: GrantScope[];
  /** Classifier label when §3.8 ran. */
  classifier?: ClassifierLabel;
}

/** Scopes an ask offers: §3.4 caps by class, §3.2 caps further by mode, §3.6 by taint. */
function scopesFor(mode: PermissionMode, se: SideEffect, taint = false): GrantScope[] {
  // §3.6, §3.12: a tainted destructive / financial card offers `once` only.
  if (taint && SEVERITY[se] >= SEVERITY.destructive) return ["once"];
  if (se === "financial") return mode === "manual" ? ["once"] : ["once", "always"]; // §3.4
  if (se === "destructive") return mode === "manual" ? ["once"] : ["once", "task", "always"];
  if (mode === "manual") {
    // §3.2 manual/read: "first read of each new source asks (task / site offered)".
    if (se === "read") return ["once", "task", "site"];
    return ["once"]; // §3.2 manual/write: ask every time, nothing reusable.
  }
  return ALL; // §3.2 balanced/write: "once / task / site / session / always".
}

function expected(c: Case): Expected {
  const { mode, se, taint, prior } = c;
  // §3.2: `none` tools run in every mode, plan included; nothing escalates them (§3.6 is write+).
  if (se === "none") return { decision: "allow", rule: `mode:${mode}/none` };
  // §3.2 plan row: everything but `none` is denied. §3.3 step 2 precedes taint (step 4), and
  // taint "may turn allow into ask, never the reverse", so it never rescues a deny.
  if (mode === "plan") return { decision: "deny", rule: "mode:plan" };

  // §3.3 step 4 / §3.6: a tainted write / destructive / financial on a new target asks
  // "regardless of site / session / always grants".
  if (taint && SEVERITY[se] >= SEVERITY.write) {
    return { decision: "ask", rule: "taint:new_target", scopes: scopesFor(mode, se, taint) };
  }

  // §3.3 step 5: standing grants. §3.2: manual does not consult allow-grants for writes (nor
  // destructive / financial, which it asks `once`).
  const grantLive = prior === "grant" && !(mode === "manual" && SEVERITY[se] >= SEVERITY.write);
  if (grantLive) {
    // §3.2 auto/write "within existing grants: classifier routine → allow"; §3.3 step 7.
    // The default RulesClassifier labels an untainted write with an owner request `routine`.
    if (mode === "auto" && se === "write")
      return { decision: "allow", rule: "grant:", classifier: "routine" };
    return { decision: "allow", rule: "grant:" };
  }

  // §3.3 step 6: mode default (§3.2 table).
  const modeRule = `mode:${mode}/${se}`;
  switch (se) {
    case "read":
      // §3.2 auto/read: "new ordinary origins allowed unless tainted or sensitive".
      if (mode === "auto" && !taint) return { decision: "allow", rule: modeRule };
      // §3.2: only the *first* read of a source asks.
      if (prior === "touched") return { decision: "allow", rule: `${modeRule}:touched` };
      return { decision: "ask", rule: `${modeRule}:new_source`, scopes: scopesFor(mode, se) };
    default:
      // write: "ask" (manual every time, balanced / auto outside grants);
      // destructive: "ask, once / task / always"; financial: "ask, once / always".
      return { decision: "ask", rule: modeRule, scopes: scopesFor(mode, se) };
  }
}

/** Cases where the engine deviates from the doc-derived expectation (run as `it.fails`). None today. */
const KNOWN_DEVIATIONS = new Map<string, string>();

// ---- harness -------------------------------------------------------------------------------

const OWNER_MESSAGES = ["please reorder the usual coffee beans from the shop"];

function ctxFor(
  mode: PermissionMode,
  taint: boolean,
  extra: Partial<PolicyContext> = {},
): PolicyContext {
  return {
    ...CTX,
    permissionMode: mode,
    taint,
    ownerMessages: OWNER_MESSAGES,
    ...(taint
      ? {
          newTarget: true,
          taintSources: [{ sourceKind: "browser_snapshot", origin: "https://evil.example.net" }],
        }
      : {}),
    ...extra,
  };
}

/** The setup approvals run in balanced mode, untainted, in the same Task. */
const SETUP_CTX = ctxFor("balanced", false);

async function prepare(h: Harness, c: PolicyCall, se: SideEffect, prior: Prior): Promise<void> {
  if (prior === "touched") await approve(h, c, SETUP_CTX, "once");
  if (prior === "grant") await approve(h, c, SETUP_CTX, GRANT_SCOPE[se]);
}

async function runCase(
  kase: Case,
  extra: Partial<PolicyContext> = {},
  target = SHOP,
): Promise<PolicyDecision> {
  const h = makeBroker();
  const c = call(TOOL, kase.se, origin(target));
  await prepare(h, c, kase.se, kase.prior);
  return h.broker.decide(c, ctxFor(kase.mode, kase.taint, extra));
}

/** Invariants every decision carries, whatever the case. */
function checkShape(d: PolicyDecision, se: SideEffect): void {
  expect(typeof d.rule).toBe("string");
  expect(d.rule.length).toBeGreaterThan(0);
  expect(Array.isArray(d.trace)).toBe(true);
  expect(d.trace.length).toBeGreaterThan(0);
  expect(d.trace.at(-1)).toBe(`${d.decision}:${d.rule}`);
  expect(d.sideEffect).toBe(se);
  if (d.decision === "ask") {
    expect(d.bindingHash).toMatch(HASH);
    expect(d.grantKey).toMatch(HASH);
    expect(d.approvalKind).toBe("connector_action");
    expect(d.scopesOffered?.length ?? 0).toBeGreaterThan(0);
    for (const s of d.scopesOffered ?? [])
      expect(allowedScopes(se, "connector_action")).toContain(s);
    if (se === "financial")
      for (const s of d.scopesOffered ?? []) expect(["once", "always"]).toContain(s);
    if (se === "destructive")
      for (const s of d.scopesOffered ?? []) expect(["once", "task", "always"]).toContain(s);
  } else {
    expect(d.scopesOffered).toBeUndefined();
    expect(d.deferred).toBeUndefined();
  }
  if (d.decision === "allow" && d.rule.startsWith("grant:")) expect(d.grantId).toBeDefined();
}

function checkExpected(d: PolicyDecision, e: Expected): void {
  expect(d.decision).toBe(e.decision);
  if (e.rule.endsWith(":")) expect(d.rule.startsWith(e.rule)).toBe(true);
  else expect(d.rule).toBe(e.rule);
  if (e.scopes !== undefined) expect(d.scopesOffered).toEqual(e.scopes);
  if (e.classifier !== undefined) expect(d.classifier?.label).toBe(e.classifier);
}

// ---- the matrix ----------------------------------------------------------------------------

describe("decision matrix: mode × side effect × taint × standing grant", () => {
  it("covers every combination", () => {
    // 4 modes × (1 none + 3 read + 2 write + 2 destructive + 2 financial) × 2 taint.
    expect(CASES).toHaveLength(80);
  });

  for (const kase of CASES) {
    const name = caseName(kase);
    const e = expected(kase);
    const test = KNOWN_DEVIATIONS.has(name) ? it.fails : it;
    test(`${name} → ${e.decision} (${e.rule})`, async () => {
      const d = await runCase(kase);
      checkShape(d, kase.se);
      checkExpected(d, e);
      expect(d.deferred).toBeUndefined();

      // §3.3: unattended runs defer an ask into the approvals queue; allow / deny are unchanged.
      const u = await runCase(kase, { unattended: true });
      checkShape(u, kase.se);
      checkExpected(u, e);
      if (u.decision === "ask") expect(u.deferred).toBe(true);
      else expect(u.deferred).toBeUndefined();
    });
  }
});

describe("matrix properties", () => {
  it("taint never turns a deny into ask / allow, and only turns allow into ask via taint:", async () => {
    for (const kase of CASES.filter((c) => !c.taint)) {
      const clean = await runCase(kase);
      const dirty = await runCase({ ...kase, taint: true });
      const label = caseName(kase);
      if (clean.decision === "deny") {
        expect(dirty.decision, label).toBe("deny");
        expect(dirty.rule, label).toBe(clean.rule);
      } else if (clean.decision === "ask") {
        // §3.3 step 4: "never the reverse".
        expect(dirty.decision, label).toBe("ask");
      } else if (dirty.decision !== "allow") {
        expect(dirty.decision, label).toBe("ask");
        if (SEVERITY[kase.se] >= SEVERITY.write) expect(dirty.rule.startsWith("taint:")).toBe(true);
      }
    }
  });

  it("financial is allowed only by the owner's confirmed always grant, never manual or tainted", async () => {
    for (const kase of CASES.filter((c) => c.se === "financial")) {
      const d = await runCase(kase);
      const allowed =
        kase.prior === "grant" && !kase.taint && kase.mode !== "manual" && kase.mode !== "plan";
      if (allowed) expect(d.rule, caseName(kase)).toMatch(/^grant:/);
      else expect(d.decision, caseName(kase)).not.toBe("allow");
      if (d.decision === "ask" && (kase.taint || kase.mode === "manual"))
        expect(d.scopesOffered).toEqual(["once"]);
    }
  });

  it("financial and destructive approvals refuse reusable scopes beyond §3.4", async () => {
    const h = makeBroker();
    await expect(
      approve(h, call(TOOL, "financial", origin(SHOP)), SETUP_CTX, "task"),
    ).rejects.toThrow(/scope task not offered/);
    await expect(
      approve(h, call(TOOL, "financial", origin(SHOP)), SETUP_CTX, "session"),
    ).rejects.toThrow(/scope session not offered/);
    await expect(
      approve(h, call(TOOL, "destructive", origin(SHOP)), SETUP_CTX, "session"),
    ).rejects.toThrow(/scope session not offered/);
    expect(await h.broker.listGrants()).toEqual([]);
  });

  it("a task grant for destructive does not leak to another Task", async () => {
    const h = makeBroker();
    const c = call(TOOL, "destructive", origin(SHOP));
    await approve(h, c, SETUP_CTX, "task");
    const same = await h.broker.decide(c, ctxFor("balanced", false));
    expect(same.decision).toBe("allow");
    const other = await h.broker.decide(c, ctxFor("balanced", false, { taskId: "task_2" }));
    expect(other.decision).toBe("ask");
    expect(other.rule).toBe("mode:balanced/destructive");
  });
});

// ---- reads: new vs touched, sensitive hosts --------------------------------------------------

describe("reads (§3.2 read column)", () => {
  it("balanced: a new origin asks, a touched origin allows, another origin still asks", async () => {
    const h = makeBroker();
    const ctx = ctxFor("balanced", false);
    const first = await h.broker.decide(call(TOOL, "read", origin(SHOP)), ctx);
    expect(first.decision).toBe("ask");
    expect(first.rule).toBe("mode:balanced/read:new_source");
    await approve(h, call(TOOL, "read", origin(SHOP)), ctx, "once");
    // Reads are asked per origin, not per page (§3.2).
    const samePageOther = await h.broker.decide(
      call(TOOL, "read", origin(`${SHOP}/other/page?x=1`)),
      ctx,
    );
    expect(samePageOther.decision).toBe("allow");
    expect(samePageOther.rule).toBe("mode:balanced/read:touched");
    const other = await h.broker.decide(
      call(TOOL, "read", origin("https://news.example.org")),
      ctx,
    );
    expect(other.decision).toBe("ask");
  });

  it("auto: a new ordinary origin is allowed and then counts as touched", async () => {
    const h = makeBroker();
    const d = await h.broker.decide(call(TOOL, "read", origin(SHOP)), ctxFor("auto", false));
    expect(d.decision).toBe("allow");
    expect(d.rule).toBe("mode:auto/read");
    // Touched in this Task: even a later tainted read of it (no escalation for reads) allows.
    const later = await h.broker.decide(call(TOOL, "read", origin(SHOP)), ctxFor("auto", true));
    expect(later.decision).toBe("allow");
    expect(later.rule).toBe("mode:auto/read:touched");
  });

  it("auto: a new origin asks when the turn is tainted", async () => {
    const h = makeBroker();
    const d = await h.broker.decide(call(TOOL, "read", origin(SHOP)), ctxFor("auto", true));
    expect(d.decision).toBe("ask");
    expect(d.rule).toBe("mode:auto/read:new_source");
  });

  for (const mode of ["manual", "balanced", "auto"] as const) {
    for (const taint of [false, true]) {
      for (const prior of ["none", "touched"] as const) {
        it(`sensitive host read always asks: ${mode} × ${taint ? "tainted" : "untainted"} × ${prior}`, async () => {
          const h = makeBroker();
          const c = call(TOOL, "read", origin(BANK));
          if (prior === "touched") await approve(h, c, SETUP_CTX, "once");
          const d = await h.broker.decide(c, ctxFor(mode, taint));
          checkShape(d, "read");
          expect(d.decision).toBe("ask");
          expect(d.rule).toBe(`mode:${mode}/read:sensitive`);
        });
      }
    }
  }

  it("sensitive host read in plan mode is denied (plan beats everything but none)", async () => {
    const h = makeBroker();
    const d = await h.broker.decide(call(TOOL, "read", origin(BANK)), ctxFor("plan", false));
    expect(d.decision).toBe("deny");
    expect(d.rule).toBe("mode:plan");
  });

  // §3.2 balanced/read: "sensitive categories always ask": only `once` is offered and an earlier
  // approval does not silence the next read.
  it("sensitive host read offers once only and asks again after an approval", async () => {
    const h = makeBroker();
    const c = call(TOOL, "read", origin(BANK));
    const { d: first } = await approve(h, c, SETUP_CTX, "once");
    expect(first.scopesOffered).toEqual(["once"]);
    const d = await h.broker.decide(c, ctxFor("balanced", false));
    expect(d.decision).toBe("ask");
  });
});

// ---- writes in auto: the default RulesClassifier (§3.8) --------------------------------------

describe("auto-mode writes within grants go through the default RulesClassifier", () => {
  async function grantedWrite(extra: Partial<PolicyContext>, taint = false) {
    const h = makeBroker();
    const c = call(TOOL, "write", origin(SHOP));
    await approve(h, c, SETUP_CTX, "always");
    return h.broker.decide(c, ctxFor("auto", taint, extra));
  }

  it("routine with owner messages and no taint → allow with the grant", async () => {
    const d = await grantedWrite({});
    expect(d.decision).toBe("allow");
    expect(d.rule.startsWith("grant:")).toBe(true);
    expect(d.classifier?.label).toBe("routine");
    expect(d.trace).toContain("step7:classifier");
  });

  it("no owner messages → sensitive → ask classifier:sensitive", async () => {
    const d = await grantedWrite({ ownerMessages: [] });
    expect(d.decision).toBe("ask");
    expect(d.rule).toBe("classifier:sensitive");
    expect(d.bindingHash).toMatch(HASH);
  });

  it("tainted but on an approved (not new) target → classifier sees taint → sensitive ask", async () => {
    const d = await grantedWrite({ newTarget: false }, true);
    expect(d.decision).toBe("ask");
    expect(d.rule).toBe("classifier:sensitive");
  });

  it("tainted on a new target → taint escalation wins before the classifier runs", async () => {
    const d = await grantedWrite({}, true);
    expect(d.decision).toBe("ask");
    expect(d.rule).toBe("taint:new_target");
    expect(d.trace).not.toContain("step7:classifier");
  });

  it("balanced never runs the classifier on a granted write", async () => {
    const h = makeBroker();
    const c = call(TOOL, "write", origin(SHOP));
    await approve(h, c, SETUP_CTX, "always");
    const d = await h.broker.decide(c, ctxFor("balanced", false, { ownerMessages: [] }));
    expect(d.decision).toBe("allow");
    expect(d.classifier).toBeUndefined();
    expect(d.trace).not.toContain("step7:classifier");
  });
});

// ---- circuit breakers (§3.8) -----------------------------------------------------------------

class ScriptedClassifier implements ActionClassifier {
  readonly id = "scripted";
  readonly seen: ClassifierInput[] = [];
  label: ClassifierLabel;
  constructor(label: ClassifierLabel) {
    this.label = label;
  }
  async classify(input: ClassifierInput) {
    this.seen.push(input);
    return { label: this.label, reason: `scripted ${this.label}` };
  }
}

describe("classifier circuit breakers (§3.8)", () => {
  async function setup(label: ClassifierLabel) {
    const classifier = new ScriptedClassifier(label);
    const events: string[] = [];
    const h = makeBroker({ classifier, onEvent: (e) => events.push(e.type) });
    const c = call(TOOL, "write", origin(SHOP));
    await approve(h, c, SETUP_CTX, "always");
    return { h, c, classifier, events, auto: ctxFor("auto", false) };
  }

  it("three consecutive sensitive labels downgrade the Task; auto then behaves like balanced", async () => {
    const { h, c, classifier, events, auto } = await setup("sensitive");
    for (let i = 1; i <= 3; i += 1) {
      const d = await h.broker.decide(c, auto);
      expect(d.decision).toBe("ask");
      expect(d.rule).toBe("classifier:sensitive");
      expect(h.broker.taskStatus("task_1").downgraded).toBe(i === 3);
    }
    expect(events).toContain("task.downgraded");
    expect(classifier.seen).toHaveLength(3);

    // Balanced semantics: the grant allows without the classifier ...
    const granted = await h.broker.decide(c, auto);
    expect(granted.decision).toBe("allow");
    expect(granted.rule.startsWith("grant:")).toBe(true);
    expect(classifier.seen).toHaveLength(3);
    // ... and a new ordinary origin asks instead of being allowed (§3.2 balanced vs auto read).
    const read = await h.broker.decide(
      call(TOOL, "read", origin("https://news.example.org")),
      auto,
    );
    expect(read.decision).toBe("ask");
    expect(read.rule).toBe("mode:balanced/read:new_source");
    expect(h.broker.taskStatus("task_1").paused).toBe(false);
  });

  it("a routine label resets the consecutive-sensitive counter", async () => {
    const { h, c, classifier, auto } = await setup("sensitive");
    await h.broker.decide(c, auto);
    await h.broker.decide(c, auto);
    classifier.label = "routine";
    expect((await h.broker.decide(c, auto)).decision).toBe("allow");
    classifier.label = "sensitive";
    await h.broker.decide(c, auto);
    await h.broker.decide(c, auto);
    expect(h.broker.taskStatus("task_1").downgraded).toBe(false);
    await h.broker.decide(c, auto);
    expect(h.broker.taskStatus("task_1").downgraded).toBe(true);
  });

  it("two prohibited labels pause the Task; the next decide denies classifier:task_paused", async () => {
    const { h, c, events, auto } = await setup("prohibited");
    const first = await h.broker.decide(c, auto);
    expect(first.decision).toBe("deny");
    expect(first.rule).toBe("classifier:prohibited");
    expect(first.classifier?.label).toBe("prohibited");
    expect(h.broker.taskStatus("task_1").paused).toBe(false);

    const second = await h.broker.decide(c, auto);
    expect(second.decision).toBe("deny");
    expect(second.rule).toBe("classifier:prohibited");
    expect(h.broker.taskStatus("task_1").paused).toBe(true);
    expect(events).toContain("task.paused");
    const notes = await h.notifier.list();
    expect(notes.some((n) => n.kind === "task_failed")).toBe(true);

    // Paused: every call of the Task is denied, even side-effect-free ones in any mode.
    for (const [se, mode] of [
      ["write", "auto"],
      ["none", "balanced"],
      ["read", "manual"],
    ] as const) {
      const d = await h.broker.decide(call(TOOL, se, origin(SHOP)), ctxFor(mode, false));
      expect(d.decision).toBe("deny");
      expect(d.rule).toBe("classifier:task_paused");
      checkShape(d, se);
    }
    // Other Tasks are unaffected.
    const other = await h.broker.decide(
      call(TOOL, "none", origin(SHOP)),
      ctxFor("auto", false, { taskId: "task_2" }),
    );
    expect(other.decision).toBe("allow");

    // The owner resumes it; it never resets itself.
    h.broker.resumeTask("task_1");
    const resumed = await h.broker.decide(call(TOOL, "none", origin(SHOP)), auto);
    expect(resumed.decision).toBe("allow");
  });
});

// ---- hooks (§3.3 step 3) ---------------------------------------------------------------------

function hook(
  name: string,
  fn: (c: PolicyCall, ctx: PolicyContext) => HookResult | undefined,
  calls: PolicyCall[] = [],
): PolicyHook {
  return {
    name,
    beforeToolCall(c, ctx) {
      calls.push(c);
      return fn(c, ctx);
    },
  };
}

describe("hooks (§3.3 step 3: deny or ask, never allow; rewrite restarts at step 1)", () => {
  const balanced = ctxFor("balanced", false);

  it("{decision: allow} does not allow an ask", async () => {
    const h = makeBroker({ hooks: [hook("yes", () => ({ decision: "allow" }))] });
    const w = await h.broker.decide(call(TOOL, "write", origin(SHOP)), balanced);
    expect(w.decision).toBe("ask");
    expect(w.rule).toBe("mode:balanced/write");
    const r = await h.broker.decide(call(TOOL, "read", origin(SHOP)), balanced);
    expect(r.decision).toBe("ask");
    const f = await h.broker.decide(call(TOOL, "financial", origin(SHOP)), ctxFor("auto", false));
    expect(f.decision).toBe("ask");
  });

  it("{decision: deny} denies, even a call a grant would allow", async () => {
    const h = makeBroker({ hooks: [hook("no", () => ({ decision: "deny", reason: "nope" }))] });
    const none = await h.broker.decide(call(TOOL, "none", origin(SHOP)), balanced);
    expect(none.decision).toBe("deny");
    expect(none.rule).toBe("hook:no");
    expect(none.reason).toBe("nope");
    checkShape(none, "none");
  });

  it("{decision: deny} beats a standing grant", async () => {
    let on = false;
    const h = makeBroker({ hooks: [hook("gate", () => (on ? { decision: "deny" } : undefined))] });
    const c = call(TOOL, "write", origin(SHOP));
    await approve(h, c, SETUP_CTX, "always");
    expect((await h.broker.decide(c, balanced)).decision).toBe("allow");
    on = true;
    const d = await h.broker.decide(c, balanced);
    expect(d.decision).toBe("deny");
    expect(d.rule).toBe("hook:gate");
  });

  it("{decision: ask} turns a would-be allow into ask", async () => {
    let on = false;
    const h = makeBroker({ hooks: [hook("check", () => (on ? { decision: "ask" } : undefined))] });
    const none = call(TOOL, "none", origin(SHOP));
    const w = call(TOOL, "write", origin(SHOP));
    await approve(h, w, SETUP_CTX, "always");
    expect((await h.broker.decide(none, balanced)).decision).toBe("allow");
    expect((await h.broker.decide(w, balanced)).decision).toBe("allow");
    on = true;
    for (const c of [none, w]) {
      const d = await h.broker.decide(c, balanced);
      expect(d.decision).toBe("ask");
      expect(d.rule).toBe("hook:check");
      checkShape(d, c.sideEffect);
    }
  });

  it("hooks do not run once steps 1–2 denied (plan mode)", async () => {
    const seen: PolicyCall[] = [];
    const h = makeBroker({ hooks: [hook("spy", () => ({ decision: "ask" }), seen)] });
    const d = await h.broker.decide(call(TOOL, "write", origin(SHOP)), ctxFor("plan", false));
    expect(d.decision).toBe("deny");
    expect(d.rule).toBe("mode:plan");
    expect(seen).toHaveLength(0);
  });

  const original = call(TOOL, "write", origin(SHOP), { params: { qty: 1 } });
  const rewritten = call(TOOL, "write", origin(SHOP), { params: { qty: 2, rewritten: true } });
  const rewriteOnce = () =>
    hook("fixer", (c) =>
      (c.params as { rewritten?: boolean }).rewritten === true
        ? undefined
        : { rewrite: rewritten, reason: "normalized qty" },
    );

  it("{rewrite} ends at ask, once only, bound to the rewritten call — even over a grant", async () => {
    const h = makeBroker({ hooks: [rewriteOnce()] });
    // An always grant on the grantKey (tool + target) that both calls share.
    await approve(h, rewritten, SETUP_CTX, "always");
    const allowed = await h.broker.decide(rewritten, balanced);
    expect(allowed.decision).toBe("allow");

    const d = await h.broker.decide(original, balanced);
    checkShape(d, "write");
    expect(d.decision).toBe("ask");
    expect(d.rule).toBe("hook:rewrite");
    expect(d.scopesOffered).toEqual(["once"]);
    expect(d.trace).toContain("hook:rewrite(fixer)");
    expect(d.call.paramsHash).toBe(rewritten.paramsHash);

    const plain = makeBroker();
    const expectRewritten = await plain.broker.decide(rewritten, balanced);
    const expectOriginal = await plain.broker.decide(original, balanced);
    expect(d.bindingHash).toBe(expectRewritten.bindingHash);
    expect(d.bindingHash).not.toBe(expectOriginal.bindingHash);
    expect(d.grantKey).toBe(expectRewritten.grantKey);
  });

  it("{rewrite} of a side-effect-free call still ends at ask", async () => {
    const target = call(TOOL, "none", origin(SHOP), { params: { rewritten: true } });
    const h = makeBroker({
      hooks: [
        hook("fixer", (c) =>
          (c.params as { rewritten?: boolean }).rewritten === true
            ? undefined
            : { rewrite: target },
        ),
      ],
    });
    const d = await h.broker.decide(call(TOOL, "none", origin(SHOP)), balanced);
    expect(d.decision).toBe("ask");
    expect(d.rule).toBe("hook:rewrite");
    expect(d.scopesOffered).toEqual(["once"]);
  });

  it("{rewrite} restarts at step 1: a rewrite into a denied tool is denied", async () => {
    const blocked = call("conn.blocked", "write", origin(SHOP), { params: { rewritten: true } });
    const h = makeBroker({
      policy: { deny: ["conn.blocked"] },
      hooks: [
        hook("swap", (c) =>
          (c.params as { rewritten?: boolean }).rewritten === true
            ? undefined
            : { rewrite: blocked },
        ),
      ],
    });
    const d = await h.broker.decide(original, balanced);
    expect(d.decision).toBe("deny");
    expect(d.rule.startsWith("policy:deny:")).toBe(true);
    expect(d.trace).toContain("hook:rewrite(swap)");
  });

  it("a hook that always rewrites ends in deny hook:rewrite_loop", async () => {
    let n = 0;
    const h = makeBroker({
      hooks: [
        hook("looper", () => {
          n += 1;
          return { rewrite: call(TOOL, "write", origin(SHOP), { params: { n } }) };
        }),
      ],
    });
    const d = await h.broker.decide(original, balanced);
    checkShape(d, "write");
    expect(d.decision).toBe("deny");
    expect(d.rule).toBe("hook:rewrite_loop");
    expect(d.trace.filter((t) => t === "hook:rewrite(looper)").length).toBeGreaterThan(1);
  });
});
