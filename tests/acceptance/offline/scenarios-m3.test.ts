import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AgentToolRegistration, codingTools, type GitRunner } from "@psyche/agent-core";
import { afterAll, describe, expect, it } from "vitest";
import { fileTools } from "../../../packages/files/src/index.ts";
import { FakeSandboxRunner } from "../../../packages/testing/src/fakes/FakeSandboxRunner.ts";
import { runScenario } from "../../../packages/testing/src/scenarios/index.ts";
import type { Stack } from "../../../packages/testing/src/scenarios/stack.ts";
import type { Scenario } from "../../../packages/testing/src/scenarios/types.ts";
import { ROOT, writeReport } from "../src/report.ts";

/**
 * The Milestone 3 acceptance scenarios (tests/acceptance/scenarios-m3) in scripted mode: S18's
 * runner with the real agent loop, Permission Broker and audit chain, and for V10 the real
 * coding tools (`codingTools` from agent-core over the P9 file tools from @psyche/files) on a
 * fresh copy of the fixture repository with a bare remote. Commands run in the FakeSandboxRunner
 * (never on the host): `npm test` passes once src/add.js returns the sum, as the fixture's own
 * check would. Git is the host binary with a fixed identity and dates, so the fix's commit is
 * deterministic and the scenario can name it on the push card.
 */

const run = promisify(execFile);
const DIR = join(ROOT, "tests/acceptance/scenarios-m3");
const known: Record<string, Record<string, string>> = JSON.parse(
  readFileSync(join(DIR, "known-failures.json"), "utf8"),
);

const IDENTITY = {
  GIT_AUTHOR_NAME: "Avery Lin",
  GIT_AUTHOR_EMAIL: "owner@example.com",
  GIT_AUTHOR_DATE: "2026-10-19T08:30:00-07:00",
  GIT_COMMITTER_NAME: "Avery Lin",
  GIT_COMMITTER_EMAIL: "owner@example.com",
  GIT_COMMITTER_DATE: "2026-10-19T08:30:00-07:00",
};
const GIT_ENV = {
  ...process.env,
  ...IDENTITY,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

/** The host git the Gateway composes (argv only), with the scenario's fixed identity. */
const git: GitRunner = {
  async run(cwd, args) {
    try {
      const r = await run("git", [...args], { cwd, env: GIT_ENV });
      return { exitCode: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      const e = err as { code?: unknown; stdout?: string; stderr?: string };
      return {
        exitCode: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
  },
};

const sh = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd, env: GIT_ENV })).stdout.trim();

const MESSAGE = "Fix add() to return the sum";
const FIXED = "export function add(a, b) {\n  return a + b;\n}\n";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** A fresh copy of fixtures/repo, committed, with a bare `origin`. */
async function fixtureRepo(): Promise<{ repo: string; remote: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-v10-")));
  temps.push(dir);
  const repo = join(dir, "repo");
  const remote = join(dir, "origin.git");
  cpSync(join(DIR, "v10-coding-helper/fixtures/repo"), repo, { recursive: true });
  await sh(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  await sh(repo, "init", "--quiet", "--initial-branch=main");
  await sh(repo, "add", "--all");
  await sh(repo, "commit", "--quiet", "-m", "Add add() and its check");
  await sh(repo, "remote", "add", "origin", remote);
  return { repo, remote };
}

/** The commit the scenario's fix produces: same tree, parent, identity, dates and message. */
async function expectedCommit(): Promise<string> {
  const { repo } = await fixtureRepo();
  writeFileSync(join(repo, "src/add.js"), FIXED);
  await sh(repo, "add", "--all");
  await sh(repo, "commit", "--quiet", "-m", MESSAGE);
  return sh(repo, "rev-parse", "HEAD");
}

function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") {
    return Object.entries(vars).reduce((s, [k, v]) => s.split(k).join(v), value);
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  }
  return value;
}

interface V10Run {
  report: Awaited<ReturnType<typeof runScenario>>;
  stack: Stack;
  runner: FakeSandboxRunner;
  repo: string;
  remote: string;
  commit: string;
}

async function runV10(): Promise<V10Run> {
  const commit = await expectedCommit();
  const { repo, remote } = await fixtureRepo();
  // Stands in for the fixture's check against the mounted repository: scripts match in
  // order, and the passing one applies once the fix is on disk.
  const fixed = () => readFileSync(join(repo, "src/add.js"), "utf8").includes("a + b");
  const npmTest = (argv: string[]) => argv.join(" ") === "npm test";
  const runner = new FakeSandboxRunner()
    .script((r) => npmTest(r.argv) && fixed(), { stdout: "ok 2 checks\n" })
    .script((r) => npmTest(r.argv), {
      exitCode: 1,
      stderr: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n0 !== 4\n",
    });
  let stack: Stack | undefined;
  const report = await runScenario(join(DIR, "v10-coding-helper"), {
    mutate: (sc: Scenario) => {
      const filled = substitute(sc, {
        "@REPO@": repo,
        "@OUTSIDE@": join(repo, "../.."),
        "@REMOTE@": remote,
        "@COMMIT@": commit,
      });
      Object.assign(sc, filled);
    },
    stack: {
      registrations: (s) => {
        stack = s;
        const folders = [{ path: repo, mode: "rw" as const }];
        // The owner granted the repository folder read-write (permissions.policy.folders).
        s.broker.setPolicy({ ...s.broker.policy, folders });
        const files = fileTools({ folders: () => s.broker.policy.folders });
        const pick = (name: string) =>
          files.find((t) => t.spec.name === name) as AgentToolRegistration;
        return codingTools({
          files: { read: pick("read_file"), write: pick("write_file") },
          folders: () => s.broker.policy.folders,
          runner,
          git,
          broker: s.broker,
        });
      },
    },
  });
  if (stack === undefined) throw new Error("the Stack was never built");
  return { report, stack, runner, repo, remote, commit };
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
    const receipts = await r.stack.broker.listReceipts();
    const edit = receipts.find((x) => x.kind === "file_write");
    expect(edit?.payload).toMatchObject({ diff: expect.stringContaining("+  return a + b;") });
    const push = receipts.find((x) => x.kind === "git_push");
    expect(push?.externalRefs).toEqual({ commit: r.commit, branch: "main" });
    const card = (await r.stack.broker.list({})).find((a) => a.kind === "git_push");
    expect(card?.scopesOffered).toEqual(["once"]);
  });
});
