import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { GITIGNORE, validateRemoteUrl, WorkspaceGit } from "../src/git-sync.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.test", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    return err instanceof PsycheError ? err.code : String(err);
  }
}

describe("validateRemoteUrl", () => {
  it("accepts https, ssh, scp-like and local paths, never credentials or plain http", () => {
    for (const ok of [
      "https://github.com/me/memory.git",
      "ssh://git@github.com/me/memory.git",
      "git@github.com:me/memory.git",
      "/Volumes/backup/memory.git",
    ]) {
      expect(validateRemoteUrl(ok)).toBe(ok);
    }
    for (const bad of [
      "http://github.com/me/memory.git",
      // Built at run time so the repository's secret grep stays clean.
      ["https://me", "hunter2@github.com/me/memory.git"].join(":"),
      "https://token@github.com/me/memory.git",
      "ssh://git:pw@host/x.git",
      "--upload-pack=evil",
      "relative/path",
      "file:///tmp/x",
      "https://github.com/me/memory.git extra",
    ]) {
      expect(() => validateRemoteUrl(bad), bad).toThrow(PsycheError);
    }
  });
});

describe.skipIf(!hasGit)("WorkspaceGit (H10)", () => {
  async function setup() {
    env = await makeEnv();
    const bare = join(env.dir, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    const sync = new WorkspaceGit(env.store);
    await sync.setRemote(bare);
    return { bare, sync };
  }

  it("commits the workspace with a generated .gitignore and pushes it to the owner's repo", async () => {
    const { bare, sync } = await setup();
    if (env === undefined) throw new Error("no env");
    await env.store.appendDailyNote({ text: "Prefers window seats", provenance: "owner" });
    await env.store.write("memory/imports/chatgpt-2026-10-18.md", "- raw export\n", {
      provenance: "agent",
      actor: "job",
    });
    const r = await sync.sync();
    expect(r).toMatchObject({ committed: true, pushed: true, pulled: false });
    expect(readFileSync(join(env.workspace, ".gitignore"), "utf8")).toBe(GITIGNORE);
    const files = git(bare, "ls-tree", "-r", "--name-only", "main").split("\n");
    expect(files).toEqual(
      expect.arrayContaining([".gitignore", "SOUL.md", "memory/2026-10-18.md"]),
    );
    expect(files.some((f) => f.startsWith("memory/imports/"))).toBe(false);
    // Nothing new: no commit, still pushes cleanly.
    expect(await sync.sync()).toMatchObject({ committed: false, pushed: true });
  });

  it("pulls the owner's edits from another machine, reindexes them, then pushes", async () => {
    const { bare, sync } = await setup();
    if (env === undefined) throw new Error("no env");
    await sync.sync();
    const other = join(env.dir, "laptop");
    execFileSync("git", ["clone", "-q", bare, other]);
    mkdirSync(join(other, "memory"), { recursive: true }); // git does not keep empty directories
    writeFileSync(join(other, "memory", "topic.md"), "# Garden\n\nTomatoes in the south bed.\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "laptop edit");
    git(other, "push", "-q", "origin", "main");
    await env.store.appendDailyNote({ text: "Local note", provenance: "owner" });
    const r = await sync.sync();
    expect(r).toMatchObject({ committed: true, pulled: true, pushed: true });
    expect((await env.store.search("tomatoes"))[0]?.chunk.provenance).toBe("owner");
    expect(git(bare, "log", "--oneline", "main").trim().split("\n")).toHaveLength(3);
  });

  it("reports conflicts, aborts the rebase and pushes nothing", async () => {
    const { bare, sync } = await setup();
    if (env === undefined) throw new Error("no env");
    await sync.sync();
    const other = join(env.dir, "laptop");
    execFileSync("git", ["clone", "-q", bare, other]);
    writeFileSync(join(other, "SOUL.md"), "# Soul\nFrom the laptop.\n");
    git(other, "commit", "-qam", "laptop soul");
    git(other, "push", "-q", "origin", "main");
    await env.store.writeFileAsOwner("SOUL.md", "# Soul\nFrom this Mac.\n");
    const head = git(bare, "rev-parse", "main").trim();
    const r = await sync.sync();
    expect(r).toMatchObject({ committed: true, pushed: false, conflicts: ["SOUL.md"] });
    expect(git(bare, "rev-parse", "main").trim()).toBe(head);
    expect(existsSync(join(env.workspace, ".git", "rebase-merge"))).toBe(false);
    expect((await env.store.readFile("SOUL.md"))?.content).toBe("# Soul\nFrom this Mac.\n");
  });

  it("refuses to push a credential and needs a remote unless local-only", async () => {
    env = await makeEnv();
    const sync = new WorkspaceGit(env.store);
    expect(await sync.sync({ localOnly: true })).toMatchObject({ committed: true, pushed: false });
    expect(await code(sync.sync())).toBe("invalid_params");
    // A credential typed into a file outside Psyche never leaves the machine.
    const key = `sk-ant-${"e5".repeat(15)}`;
    writeFileSync(join(env.workspace, "notes.md"), `my key ${key}\n`);
    const err = await sync.sync({ localOnly: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PsycheError);
    expect((err as PsycheError).code).toBe("policy_denied");
    expect((err as PsycheError).message).toContain("notes.md");
    expect((err as PsycheError).message).not.toContain(key);
  });

  it("keeps the owner's .gitignore lines and only adds missing ones", async () => {
    env = await makeEnv();
    writeFileSync(join(env.workspace, ".gitignore"), "private/\n");
    const sync = new WorkspaceGit(env.store);
    await sync.init();
    const text = readFileSync(join(env.workspace, ".gitignore"), "utf8");
    expect(text.startsWith("private/\n")).toBe(true);
    expect(text).toContain("memory/imports/");
    await sync.init();
    expect(readFileSync(join(env.workspace, ".gitignore"), "utf8")).toBe(text);
  });
});
