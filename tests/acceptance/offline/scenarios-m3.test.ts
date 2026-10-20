import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runScenario } from "../../../packages/testing/src/scenarios/index.ts";
import type { Stack } from "../../../packages/testing/src/scenarios/stack.ts";
import type { Scenario } from "../../../packages/testing/src/scenarios/types.ts";
import {
  M3_SCENARIOS_DIR as DIR,
  V10_FIXED as FIXED,
  V10_MESSAGE as MESSAGE,
  sh,
  type V10World,
  v10World,
} from "../src/m3-world.ts";
import { writeReport } from "../src/report.ts";

/**
 * The Milestone 3 acceptance scenarios (tests/acceptance/scenarios-m3) in scripted mode: S18's
 * runner with the real agent loop, Permission Broker and audit chain, and for V10 the real
 * coding tools over a fresh copy of the fixture repository with a bare remote
 * (src/m3-world.ts). Commands run in the FakeSandboxRunner (never on the host).
 */

const known: Record<string, Record<string, string>> = JSON.parse(
  readFileSync(join(DIR, "known-failures.json"), "utf8"),
);

const worlds: V10World[] = [];
afterAll(() => {
  for (const w of worlds) w.dispose();
});

interface V10Run extends V10World {
  report: Awaited<ReturnType<typeof runScenario>>;
  stackRef: Stack;
}

async function runV10(): Promise<V10Run> {
  const w = await v10World();
  worlds.push(w);
  const report = await runScenario(join(DIR, "v10-coding-helper"), {
    mutate: (sc: Scenario) => w.mutate(sc),
    stack: w.overrides,
  });
  return { ...w, report, stackRef: w.stack() };
}

let v10: V10Run | undefined;
const rows: unknown[] = [];

describe("Milestone 3 acceptance scenarios, scripted mode", () => {
  it("v10-coding-helper: every hard assertion passes or is a tracked known failure", async () => {
    v10 = await runV10();
    const r = v10.report;
    const tracked = known["v10-coding-helper"] ?? {};
    const hard = r.assertions.filter((a) => a.severity === "hard");
    const unexpected = hard
      .filter((a) => a.status === "fail" && tracked[a.id] === undefined)
      .map((a) => `${a.id}: ${a.detail}`);
    const stale = Object.keys(tracked).filter(
      (k) => r.assertions.find((a) => a.id === k)?.status !== "fail",
    );
    rows.push({
      scenario: "v10-coding-helper",
      hard: r.summary.hard,
      soft: r.summary.soft,
      unexpected,
      stale,
      softFailures: r.assertions
        .filter((a) => a.severity === "soft" && a.status === "fail")
        .map((a) => `${a.id}: ${a.detail}`),
    });
    writeReport("scenarios-m3", { mode: "scripted", scenarios: rows });
    expect(unexpected, "hard failures without a tracked reason").toEqual([]);
    expect(stale, "known failures that no longer fail").toEqual([]);
    expect(r.summary.hard.unchecked, "hard assertions never evaluated").toBe(0);
  });
});

describe("V10: what the scenario file cannot see", () => {
  it("fixes the file, pushes exactly the approved commit, and never runs on the host", async () => {
    const r = v10 ?? (await runV10());
    expect(readFileSync(join(r.repo, "src/add.js"), "utf8")).toBe(FIXED);
    expect(await sh(r.remote, "rev-parse", "refs/heads/main")).toBe(r.commit);
    expect(await sh(r.repo, "log", "-1", "--format=%s")).toBe(MESSAGE);
    // Two test runs in one sandbox with the repo mounted; the refused command never ran.
    expect(r.runner.execs.map((e) => [e.argv.join(" "), e.cwd])).toEqual([
      ["npm test", "/workspace/repo"],
      ["npm test", "/workspace/repo"],
    ]);
  });

  it("the edit's receipt carries the diff and the push's receipt names the commit", async () => {
    const r = v10 ?? (await runV10());
    const receipts = await r.stackRef.broker.listReceipts();
    const edit = receipts.find((x) => x.kind === "file_write");
    expect(edit?.payload).toMatchObject({ diff: expect.stringContaining("+  return a + b;") });
    const push = receipts.find((x) => x.kind === "git_push");
    expect(push?.externalRefs).toEqual({ commit: r.commit, branch: "main" });
    const card = (await r.stackRef.broker.list({})).find((a) => a.kind === "git_push");
    expect(card?.scopesOffered).toEqual(["once"]);
  });
});
