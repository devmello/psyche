import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceGit } from "../src/git-sync.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * The git backup across two machines: trust travels with the notes (the provenance sidecar), reset
 * removes the local history, and a symlinked .gitignore is never followed.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.test", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

const envs: TestEnv[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function bareRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), "psyche-prov-"));
  dirs.push(dir);
  const remote = join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  return remote;
}

async function machine(): Promise<TestEnv> {
  const env = await makeEnv();
  envs.push(env);
  return env;
}

describe("git backup across machines", () => {
  it("an untrusted file stays untrusted after a pull on another machine", async () => {
    const remote = bareRemote();
    const a = await machine();
    const b = await machine();
    await a.store.write("memory/web.md", "# Web\n\nA claim from a page.\n", {
      provenance: "untrusted",
    });
    const gitA = new WorkspaceGit(a.store);
    await gitA.setRemote(remote);
    expect((await gitA.sync()).pushed).toBe(true);
    // The sidecar is committed with the notes and names the untrusted file.
    const [sidecarPath] = git(remote, "ls-tree", "-r", "--name-only", "main", ".psyche/provenance")
      .trim()
      .split("\n");
    const sidecar = JSON.parse(git(remote, "show", `main:${sidecarPath}`));
    expect(sidecar.files["memory/web.md"]).toBe("untrusted");

    // Machine B never saw the file: a pull must not make it the owner's.
    const gitB = new WorkspaceGit(b.store);
    await gitB.setRemote(remote);
    const pulled = await gitB.sync();
    expect(pulled.pulled).toBe(true);
    const onB = (await b.store.listFileInfo()).find((f) => f.path === "memory/web.md");
    expect(onB?.provenance).toBe("untrusted");

    // A later sync on B keeps it untrusted too (the sidecar is written from B's index).
    await gitB.sync();
    expect((await b.store.listFileInfo()).find((f) => f.path === "memory/web.md")?.provenance).toBe(
      "untrusted",
    );
  }, 60_000);

  it("reset removes this device's git history and the sidecar", async () => {
    const a = await machine();
    const gitA = new WorkspaceGit(a.store);
    await gitA.init();
    expect(existsSync(join(a.workspace, ".git"))).toBe(true);
    await a.store.write("memory/old.md", "# Old\n\nA note to forget.\n", {
      provenance: "untrusted",
    });
    await a.store.reset();
    expect(existsSync(join(a.workspace, ".git"))).toBe(false);
    expect(existsSync(join(a.workspace, ".psyche"))).toBe(false);
  }, 60_000);

  it("never follows a symlinked .gitignore out of the workspace", async () => {
    const a = await machine();
    const outside = join(a.dir, "outside.txt");
    writeFileSync(outside, "keep me\n");
    const gitA = new WorkspaceGit(a.store);
    await gitA.init();
    rmSync(join(a.workspace, ".gitignore"));
    symlinkSync(outside, join(a.workspace, ".gitignore"));
    await gitA.init();
    expect(readFileSync(outside, "utf8")).toBe("keep me\n");
    expect(existsSync(join(a.workspace, ".gitignore"))).toBe(true);
    expect(readFileSync(join(a.workspace, ".gitignore"), "utf8")).toContain("memory/imports/");
  }, 60_000);
});
