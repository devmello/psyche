import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AgentToolRegistration, codingTools, type GitRunner } from "@psyche/agent-core";
import { fileTools } from "../../../packages/files/src/index.ts";
import { FakeSandboxRunner } from "../../../packages/testing/src/fakes/FakeSandboxRunner.ts";
import type { Stack, StackOverrides } from "../../../packages/testing/src/scenarios/stack.ts";
import type { Scenario } from "../../../packages/testing/src/scenarios/types.ts";
import { M3_SCENARIOS_DIR } from "./scenario-scripts.ts";

/**
 * The Milestone 3 scenarios' world (tests/acceptance/scenarios-m3), shared by the scripted run
 * (offline/scenarios-m3.test.ts), the live driver's plumbing test and the live gates.
 *
 * V10: the real coding tools (`codingTools` from agent-core over the P9 file tools from
 * @psyche/files) on a fresh copy of the fixture repository with a bare remote. Commands run in
 * the FakeSandboxRunner, never on the host: the fixture's check passes once src/add.js returns
 * the sum. Git is the host binary with a fixed identity and dates, so the scripted fix's commit
 * is deterministic and the scenario can name it on the push card.
 */

export { M3_SCENARIO_IDS, M3_SCENARIOS_DIR } from "./scenario-scripts.ts";

const run = promisify(execFile);

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

export const sh = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd, env: GIT_ENV })).stdout.trim();

export const V10_MESSAGE = "Fix add() to return the sum";
export const V10_FIXED = "export function add(a, b) {\n  return a + b;\n}\n";

/** A fresh copy of fixtures/repo, committed, with a bare `origin`. */
async function fixtureRepo(temps: string[]): Promise<{ repo: string; remote: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-v10-")));
  temps.push(dir);
  const repo = join(dir, "repo");
  const remote = join(dir, "origin.git");
  cpSync(join(M3_SCENARIOS_DIR, "v10-coding-helper/fixtures/repo"), repo, { recursive: true });
  await sh(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  await sh(repo, "init", "--quiet", "--initial-branch=main");
  await sh(repo, "add", "--all");
  await sh(repo, "commit", "--quiet", "-m", "Add add() and its check");
  await sh(repo, "remote", "add", "origin", remote);
  return { repo, remote };
}

/** The commit the scripted fix produces: same tree, parent, identity, dates and message. */
async function expectedCommit(temps: string[]): Promise<string> {
  const { repo } = await fixtureRepo(temps);
  writeFileSync(join(repo, "src/add.js"), V10_FIXED);
  await sh(repo, "add", "--all");
  await sh(repo, "commit", "--quiet", "-m", V10_MESSAGE);
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

/** Commands a model may use to run the fixture's check (`npm test` runs `node test/add.check.js`). */
const RUNS_CHECK =
  /^(npm (run )?test|npm t|node (--test )?(\.\/)?test\/add\.check\.js|node --test)\b/;

export interface V10World {
  /** Fills the scenario's `@REPO@`, `@OUTSIDE@`, `@REMOTE@` and `@COMMIT@`. */
  mutate: (sc: Scenario) => void;
  overrides: StackOverrides;
  stack: () => Stack;
  runner: FakeSandboxRunner;
  repo: string;
  remote: string;
  /** The scripted fix's commit (a live model's own commit differs: other message). */
  commit: string;
  /**
   * What the scenario file cannot see in live mode, as hard failures: the file is fixed, the
   * remote's main is the commit the approved card named, and nothing ran outside the sandbox.
   */
  check: () => Promise<string[]>;
  dispose: () => void;
}

/**
 * V10's world. `live`: the model writes its own commit message, so the push card's commit is
 * checked against what was pushed (`check`) instead of the scripted `@COMMIT@`, and the sandbox
 * fake accepts any usual way of running the fixture's check.
 */
/**
 * `code.git`'s input schema is a top-level `anyOf`, which Anthropic refuses (#414). For a live
 * run that measures the rest of V10 anyway, the harness can offer one object instead: every
 * branch's properties, `op` as an enum, `root` and `op` required. The tool still validates the
 * model's input against its own union. Opt-in and reported (`PSYCHE_LIVE_WORKAROUNDS=414`).
 */
export function flattenTopLevelUnion(schema: Record<string, unknown>): Record<string, unknown> {
  const branches = schema.anyOf as
    | { properties?: Record<string, Record<string, unknown>> }[]
    | undefined;
  if (branches === undefined || schema.type !== undefined) return schema;
  const properties: Record<string, Record<string, unknown>> = {};
  const ops: unknown[] = [];
  for (const b of branches)
    for (const [k, v] of Object.entries(b.properties ?? {})) {
      if (k === "op" && "const" in v) ops.push(v.const);
      else properties[k] ??= v;
    }
  return {
    type: "object",
    properties: { ...properties, op: { type: "string", enum: ops } },
    required: ["root", "op"],
  };
}

export async function v10World(
  options: { live?: boolean; workarounds?: readonly string[] } = {},
): Promise<V10World> {
  const temps: string[] = [];
  const commit = await expectedCommit(temps);
  const { repo, remote } = await fixtureRepo(temps);
  const fixed = () => readFileSync(join(repo, "src/add.js"), "utf8").includes("a + b");
  const runsCheck = (argv: string[]) =>
    options.live === true ? RUNS_CHECK.test(argv.join(" ")) : argv.join(" ") === "npm test";
  // Scripts match in order: the passing one applies once the fix is on disk.
  const runner = new FakeSandboxRunner()
    .script((r) => runsCheck(r.argv) && fixed(), { stdout: "ok 2 checks\n" })
    .script((r) => runsCheck(r.argv), {
      exitCode: 1,
      stderr: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n0 !== 4\n",
    });
  let stack: Stack | undefined;
  const vars = {
    "@REPO@": repo,
    "@OUTSIDE@": join(repo, "../.."),
    "@REMOTE@": remote,
    "@COMMIT@": commit,
  };
  const mutate = (sc: Scenario) => {
    const filled = substitute(sc, vars) as Scenario;
    if (options.live === true) {
      for (const step of filled.steps)
        for (const a of step.assertions ?? [])
          if (Array.isArray(a.mustShow))
            a.mustShow = (a.mustShow as string[]).filter((x) => x !== commit);
    }
    Object.assign(sc, filled);
  };
  const overrides: StackOverrides = {
    registrations: (s) => {
      stack = s;
      const folders = [{ path: repo, mode: "rw" as const }];
      // The owner granted the repository folder read-write (permissions.policy.folders).
      s.broker.setPolicy({ ...s.broker.policy, folders });
      const files = fileTools({ folders: () => s.broker.policy.folders });
      const pick = (name: string) =>
        files.find((t) => t.spec.name === name) as AgentToolRegistration;
      const tools = codingTools({
        files: { read: pick("read_file"), write: pick("write_file") },
        folders: () => s.broker.policy.folders,
        runner,
        git,
        broker: s.broker,
      });
      if (options.workarounds?.includes("414") === true)
        for (const t of tools)
          if (t.spec.name === "code.git")
            Object.assign(t.spec, {
              inputSchema: flattenTopLevelUnion(t.spec.inputSchema as Record<string, unknown>),
            });
      return tools;
    },
  };
  const theStack = () => {
    if (stack === undefined) throw new Error("the Stack was never built");
    return stack;
  };
  const check = async (): Promise<string[]> => {
    const errors: string[] = [];
    const s = theStack();
    if (!fixed()) errors.push("v10/fix: src/add.js does not return the sum");
    const pushed = await sh(remote, "rev-parse", "--verify", "--quiet", "refs/heads/main").catch(
      () => "",
    );
    const local = await sh(repo, "rev-parse", "HEAD");
    if (pushed !== local)
      errors.push(`v10/push: origin main is ${pushed || "missing"}, HEAD ${local}`);
    const card = (await s.broker.list({})).find((a) => a.kind === "git_push");
    const shown = card === undefined ? "" : `${card.summary}\n${JSON.stringify(card.details)}`;
    if (card === undefined) errors.push("v10/push: no git_push card");
    else if (pushed !== "" && !shown.includes(pushed))
      errors.push(`v10/push: the card does not name the pushed commit ${pushed}`);
    if (card !== undefined && card.status !== "approved")
      errors.push(`v10/push: card ${card.id} is ${card.status}`);
    const outside = runner.execs.filter((e) => !e.cwd.startsWith("/workspace/repo"));
    if (outside.length > 0)
      errors.push(
        `v10/sandbox: ran outside the mounted repo: ${outside.map((e) => e.cwd).join(", ")}`,
      );
    return errors;
  };
  return {
    mutate,
    overrides,
    stack: theStack,
    runner,
    repo,
    remote,
    commit,
    check,
    dispose: () => {
      for (const t of temps) rmSync(t, { recursive: true, force: true });
    },
  };
}
