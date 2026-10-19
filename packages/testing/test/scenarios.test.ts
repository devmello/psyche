import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionResult, PermissionBroker } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drainCaptures } from "../src/capture.ts";
import { runAllScenarios, runScenario, SCENARIOS_DIR } from "../src/scenarios/index.ts";
import { fixtureSecret } from "../src/secret-registry.ts";

// A negative test leaks the Brave key on purpose; keep this file out of a CI capture directory.
const ciCaptureDir = process.env.PSYCHE_CAPTURE_DIR;
beforeEach(() => {
  delete process.env.PSYCHE_CAPTURE_DIR;
});
afterEach(() => {
  if (ciCaptureDir !== undefined) process.env.PSYCHE_CAPTURE_DIR = ciCaptureDir;
});

const dir = (id: string) => join(SCENARIOS_DIR, id);
const failures = (r: Awaited<ReturnType<typeof runScenario>>) =>
  r.assertions.filter((a) => a.severity === "hard" && a.status === "fail").map((a) => a.id);

// Hard failures with a tracked cause (tests/scenarios/known-failures.json; #69 for V7).
const KNOWN = JSON.parse(
  readFileSync(join(SCENARIOS_DIR, "known-failures.json"), "utf8"),
) as Record<string, Record<string, string>>;
const V7_KNOWN = Object.keys(KNOWN["v7-research-brief"] ?? {});

describe("acceptance scenarios (scripted)", () => {
  it("runs V1, V2 and V7 with stable ordering", async () => {
    const report = await runAllScenarios();
    expect(report.scenarios.map((s) => s.scenario)).toEqual([
      "v1-inbox-triage",
      "v2-calendar-planning",
      "v7-research-brief",
    ]);
    const [v1, v2, v7] = report.scenarios;
    expect(failures(v1 as never)).toEqual([]);
    expect(failures(v2 as never)).toEqual([]);
    expect(failures(v7 as never)).toEqual(V7_KNOWN);
    expect(v7?.assertions.find((a) => a.id === "runner/1")?.detail).toContain("c_v7_fetch_agency");
    for (const s of report.scenarios) {
      expect(s.summary.soft.fail).toBe(0);
      expect(s.assertions.filter((a) => a.status === "unchecked")).toEqual([]);
    }
  }, 60_000);

  it("is deterministic across runs (restart and expiry paths)", async () => {
    const a = await runScenario(dir("v2-calendar-planning"));
    const b = await runScenario(dir("v2-calendar-planning"));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  }, 60_000);

  it("fails hard when a broken broker lets a send through without approval", async () => {
    const r = await runScenario(dir("v1-inbox-triage"), {
      stack: {
        wrapBroker: (b: PermissionBroker) =>
          new Proxy(b, {
            get: (t, k) =>
              k === "decide"
                ? async (): Promise<DecisionResult> => ({ decision: "allow", rule: "broken" })
                : Reflect.get(t, k),
          }),
      },
    });
    expect(r.ok).toBe(false);
    const failed = failures(r);
    expect(failed).toContain("apr_v1_send_maya"); // no card before the send
    expect(failed).toContain("final/1:receipt_count"); // more than two sends went out
    expect(failed).toContain("builtin/no_unapproved_egress"); // recipients nobody approved
  }, 60_000);

  it("fails no_secret_leak when a connector echoes the Brave key into its result", async () => {
    const key = fixtureSecret("brave-search-key", "token");
    const r = await runScenario(dir("v7-research-brief"), {
      stack: {
        wrapTool: (name, run) =>
          name !== "search.web"
            ? run
            : async (p, ctx) => {
                const res = await run(p, ctx);
                return { ...res, output: { ...(res.output as object), debug: { token: key } } };
              },
      },
    });
    drainCaptures(); // the leak is the point of this test; keep the suite's leak guard quiet
    const leak = r.assertions.filter((a) => a.type === "no_secret_leak" && a.status === "fail");
    expect(leak.map((a) => a.id)).toContain("s1-research/19:no_secret_leak");
    expect(leak.map((a) => a.id)).toContain("builtin/no_secret_leak");
    expect(leak[0]?.detail).toContain("cred:brave-search-key.token");
    expect(leak[0]?.detail).not.toContain(key);
  }, 60_000);

  it("fails when a stale-token answer is replaced by a valid one (state changes)", async () => {
    const r = await runScenario(dir("v2-calendar-planning"), {
      mutate: (sc) => {
        const step = sc.steps.find((s) => s.id === "s12-stale-answer");
        if (step === undefined) return;
        step.approvalRef = "apr_v2_market_2";
        step.token = "current";
      },
    });
    expect(failures(r)).toContain("runner/1");
    expect(failures(r)).toContain("s12-stale-answer/0:approval_status");
    expect(failures(r)).toContain("s12-stale-answer/1:no_receipt");
    expect(r.assertions.find((a) => a.id === "runner/1")?.detail).toContain(
      "expected rejected_reissued",
    );
  }, 60_000);
});
