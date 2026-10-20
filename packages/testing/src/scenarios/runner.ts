import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalRequest } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import { fixtureSecrets } from "../secret-registry.ts";
import { approvalSelected, callStatus, type EvalContext, evaluate } from "./assertions.ts";
import { Stack, type StackOverrides } from "./stack.ts";
import type {
  Assertion,
  AssertionResult,
  Counts,
  Json,
  Scenario,
  ScenarioReport,
  Step,
  StepReport,
} from "./types.ts";
import { durationMs, originOf, substitute } from "./util.ts";
import { loadFixtures, type ToolInfo, targetOf } from "./world.ts";

export const SCENARIOS_DIR = fileURLToPath(new URL("../../../../tests/scenarios", import.meta.url));

export interface RunOptions {
  stack?: StackOverrides;
  /** Edit the parsed scenario before it runs (negative tests). */
  mutate?: (scenario: Scenario) => void;
}

const STACK = {
  real: [
    "@psyche/agent-core agent loop",
    "@psyche/permissions PsychePermissionBroker (MemoryPermissionStore)",
    "@psyche/audit hash-chained audit log and receipts",
    "@psyche/connectors braveProvider and safeFetch",
  ],
  fake: [
    "FakeModelProvider (scenario scripts)",
    "FakeClock",
    "Gmail, Calendar, Library, artifacts, reminders (in-memory, from fixtures)",
    "HTTP layer for Brave and the fixture sites",
    "FakeCredentialBroker (vault)",
    "FakeBrowserDriver.site(manifest)",
    "FakeNotifier",
  ],
};

const scripted = (modes: string[] | undefined) => modes === undefined || modes.includes("scripted");
const REF_KEYS = ["approvalRef", "reissueOf", "sameBindingAs", "bindingDiffersFrom"];

/** Approval assertion ids that steps after `i` (or the final assertions) refer to. */
function referencedAfter(sc: Scenario, i: number): Set<string> {
  const out = new Set<string>();
  const add = (o: Json) => {
    for (const k of REF_KEYS) if (typeof o[k] === "string") out.add(o[k] as string);
  };
  for (const st of sc.steps.slice(i + 1)) {
    add(st as unknown as Json);
    for (const a of st.assertions ?? []) add(a);
  }
  for (const a of sc.finalAssertions ?? []) add(a);
  return out;
}

/** Run one scenario directory in scripted mode. */
export async function runScenario(dir: string, options: RunOptions = {}): Promise<ScenarioReport> {
  const sc = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
  options.mutate?.(sc);
  const tools = JSON.parse(readFileSync(join(dir, sc.tools), "utf8")).tools as ToolInfo[];
  const fx = loadFixtures(dir, sc.fixtures, sc.owner);
  const start = sc.setup.clockStart ?? String((fx.owner.clock as Json).start);
  const mode = sc.setup.permissionMode as "balanced";
  const s = new Stack(fx, tools, sc.setup.thread, mode, start, options.stack);
  s.secretRefs = sc.secretRefs;
  const c: EvalContext = {
    s,
    dir,
    snap: { approvals: [], receipts: [], audit: [], notifications: [] },
    bindings: new Map(),
    captures: {},
  };
  const results: AssertionResult[] = [];
  const steps: StepReport[] = [];
  const checked = new Set<string>();
  let n = 0;
  const hardFail = (detail: string) =>
    results.push({ id: `runner/${++n}`, type: "script", severity: "hard", status: "fail", detail });

  const snapshot = async () => {
    c.snap = {
      approvals: await s.broker.list(),
      receipts: await s.broker.listReceipts(),
      audit: await s.audit.list(),
      notifications: await s.notifier.list(),
    };
  };
  const evalAll = async (list: Assertion[] | undefined, prefix: string, step?: string) => {
    await snapshot();
    c.step = step;
    for (const [k, raw] of (list ?? []).entries()) {
      if (!scripted(raw.modes)) continue;
      const a = substitute(raw, c.captures);
      const r = evaluate(c, a);
      results.push({
        id: a.id ?? `${prefix}/${k}:${a.type}`,
        type: a.type,
        severity: a.severity,
        ...r,
      });
    }
  };
  /** Compare emitted calls with the script's `expect` and declared target (script divergence). */
  const checkScript = (final: boolean) => {
    for (const sc0 of s.scriptCalls.values()) {
      if (checked.has(sc0.id)) continue;
      const call = s.calls.get(sc0.id);
      if (call?.record === undefined) {
        if (final) hardFail(`${sc0.id}: scripted call never completed`);
        continue;
      }
      checked.add(sc0.id);
      const info = s.toolInfo.get(sc0.tool);
      // A real registration (StackOverrides.registrations) names its own target: the one the
      // loop decided, recorded on the call.
      const target =
        (info === undefined ? undefined : targetOf(info, sc0.args)?.value) ??
        call.record.target?.value;
      if (sc0.target !== null && target !== sc0.target)
        hardFail(`${sc0.id}: target ${target} ≠ ${sc0.target}`);
      const e = sc0.expect;
      if (e === undefined) continue;
      const out = s.world.results.findLast((r) => r.callId === sc0.id)?.output as Json | undefined;
      const got = {
        decision: call.record.decision,
        status: callStatus(c, call),
        errorCode: out?.errorCode,
        httpStatus: out?.httpStatus,
      };
      for (const [k, v] of Object.entries(e)) {
        if (v !== (got as Json)[k])
          hardFail(`${sc0.id}: expect.${k} ${v}, got ${(got as Json)[k]}`);
      }
    }
  };

  const answerToken = (ap: ApprovalRequest, surface = "desktop") => {
    const tokens = s.issued.get(ap.id)?.answerTokens ?? {};
    return tokens[surface] ?? Object.values(tokens)[0] ?? "";
  };
  const answer = (
    ap: ApprovalRequest,
    decision: string | undefined,
    scope?: string,
    surface = "desktop",
    token?: string,
  ) =>
    s.gateway.answer({
      approvalId: ap.id,
      answerToken: token ?? answerToken(ap, surface),
      decision: decision === "allow" ? "approve" : "deny",
      ...(decision === "allow" && scope !== undefined ? { scope: scope as "once" } : {}),
      decidedBy: { deviceId: "dev_mbp", surface },
    });

  /** Settle, then answer cards no later step addresses with `approverPolicy`. */
  const settle = async (i: number, step: Step) => {
    const later = referencedAfter(sc, i);
    const mine = (step.assertions ?? []).filter(
      (a) =>
        a.type === "approval_requested" &&
        scripted(a.modes) &&
        a.id !== undefined &&
        later.has(a.id),
    );
    const origins = new Set((fx.sites?.pages ?? []).map((p) => originOf(p.url)));
    for (let round = 0; round < 50; round += 1) {
      await s.settle();
      let answered = 0;
      for (const ap of await s.broker.list({ status: "pending" })) {
        const bound = [...c.bindings].some(([id, apId]) => apId === ap.id && later.has(id));
        if (bound || mine.some((a) => approvalSelected(c, substitute(a, c.captures), ap))) continue;
        const rule = sc.approverPolicy.rules.find(
          (r) =>
            (r.match.approvalKind === undefined || r.match.approvalKind === ap.kind) &&
            (r.match.originInFixture === undefined || origins.has(originOf(ap.target?.value))),
        );
        if (rule === undefined && sc.approverPolicy.default === "leave_pending") continue;
        await answer(ap, rule?.answer ?? "deny", rule?.scope);
        answered += 1;
      }
      if (answered === 0) return;
    }
  };

  const perform = async (step: Step): Promise<string | undefined> => {
    if (step.script !== undefined && step.kind !== "owner_message") s.enqueue(step.script.turns);
    switch (step.kind) {
      case "owner_message":
        s.enqueue(step.script?.turns ?? []);
        s.startRun(step.text ?? "", `task_${step.id}`);
        return undefined;
      case "approve": {
        const id = c.bindings.get(String(step.approvalRef));
        const ap =
          c.snap.approvals.find((x) => x.id === id) ??
          (id === undefined ? undefined : await s.broker.get(id));
        if (ap === undefined) {
          hardFail(`${step.id}: ${step.approvalRef} is not bound to a request`);
          return "unbound";
        }
        const target =
          step.token === "stale"
            ? ((await s.broker.get(s.reissueOf.get(ap.id) ?? ap.id)) ?? ap)
            : ap;
        const want = step.expectAnswer ?? "accepted";
        let got = "accepted";
        try {
          await answer(target, step.decision, step.scope, step.surface);
        } catch (err) {
          const reason =
            (err instanceof PsycheError ? (err.details as Json | undefined)?.reason : undefined) ??
            (err as Error).message;
          got = reason === "re-issued" ? "rejected_reissued" : `rejected_${String(reason)}`;
        }
        if (got !== want) hardFail(`${step.id}: answer ${got}, expected ${want}`);
        return `answer ${got}`;
      }
      case "advance_clock":
        if (step.to !== undefined) s.clock.set(Date.parse(step.to));
        else s.clock.advance(durationMs(String(step.by)));
        return new Date(s.clock.now()).toISOString();
      case "restart_gateway":
        await s.restart();
        return `generation ${s.gen}`;
      case "fault":
        if (step.fault?.kind !== "tamper_args_after_approval") {
          hardFail(`${step.id}: fault ${step.fault?.kind} is not supported by this runner`);
          return "unsupported";
        }
        s.world.faults.set(step.fault.callRef, step.fault.set);
        return `armed ${step.fault.callRef}`;
    }
  };

  for (const [i, step] of sc.steps.entries()) {
    if (!scripted(step.modes)) {
      steps.push({ id: step.id, kind: step.kind, status: "skipped" });
      continue;
    }
    s.step = step.id;
    s.world.step = step.id;
    await snapshot();
    const detail = await perform(step);
    await settle(i, step);
    await snapshot();
    checkScript(false);
    await evalAll(step.assertions, step.id, step.id);
    if (
      s.model.remainingTurns > 0 &&
      !s.runs.some((r) => r.gen === s.gen && !r.ended && s.pendingOf(r).length > 0)
    )
      hardFail(`${step.id}: ${s.model.remainingTurns} scripted turn(s) never requested`);
    steps.push({
      id: step.id,
      kind: step.kind,
      status: "ran",
      ...(detail === undefined ? {} : { detail }),
    });
  }
  s.step = "final";
  await snapshot();
  checkScript(true);
  await evalAll(sc.finalAssertions, "final");
  // Checks every run gets (README "How the runner executes a scenario", step 3).
  await evalAll(
    [
      {
        type: "no_secret_leak",
        severity: "hard",
        id: "builtin/no_secret_leak",
        secretRefs: [...new Set(fixtureSecrets().map((x) => x.id))],
      },
      { type: "no_unapproved_egress", severity: "hard", id: "builtin/no_unapproved_egress" },
    ],
    "builtin",
  );
  const chain = await s.audit.verify();
  results.push({
    id: "builtin/audit_chain",
    type: "audit_chain",
    severity: "hard",
    status: chain.ok ? "pass" : "fail",
    detail: chain.ok ? `${c.snap.audit.length} entries verify` : JSON.stringify(chain),
  });
  for (const d of s.divergences) hardFail(d);

  const count = (sev: "hard" | "soft"): Counts => {
    const r = results.filter((x) => x.severity === sev);
    return {
      pass: r.filter((x) => x.status === "pass").length,
      fail: r.filter((x) => x.status === "fail").length,
      unchecked: r.filter((x) => x.status === "unchecked").length,
    };
  };
  const summary = { hard: count("hard"), soft: count("soft") };
  return {
    scenario: sc.id,
    mode: "scripted",
    ok: summary.hard.fail === 0,
    stack: STACK,
    steps,
    assertions: results,
    summary,
  };
}

/** Every scenario directory under `root`, in name order. */
export async function runAllScenarios(root = SCENARIOS_DIR, options: RunOptions = {}) {
  const dirs = readdirSync(root)
    .filter((d) => existsSync(join(root, d, "scenario.json")))
    .sort();
  const scenarios: ScenarioReport[] = [];
  for (const d of dirs) scenarios.push(await runScenario(join(root, d), options));
  return { ok: scenarios.every((r) => r.ok), scenarios };
}
