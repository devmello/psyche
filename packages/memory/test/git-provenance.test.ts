import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

/** Whether this platform lets the test create symlinks (Windows without privileges does not). */
const canSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), "psyche-link-"));
  try {
    symlinkSync(join(dir, "target"), join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const FOREIGN = "ffffffffffffffff";

function sidecarDir(env: TestEnv): string {
  return join(env.workspace, ".psyche", "provenance");
}

function ownSidecar(env: TestEnv): string {
  const id = readFileSync(join(env.workspace, ".psyche", "machine.id"), "utf8").trim();
  return join(sidecarDir(env), `${id}.json`);
}

/** Writes another machine's sidecar, as a pull would. */
function foreignSidecar(env: TestEnv, files: Record<string, unknown>, extra = {}): string {
  mkdirSync(sidecarDir(env), { recursive: true });
  const path = join(sidecarDir(env), `${FOREIGN}.json`);
  writeFileSync(path, JSON.stringify({ version: 2, files, ...extra }));
  return path;
}

async function provenanceOf(env: TestEnv, path: string) {
  return (await env.store.listFileInfo()).find((f) => f.path === path)?.provenance;
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
    expect(sidecar.files["memory/web.md"]).toEqual({
      provenance: "untrusted",
      sha256: sha256("# Web\n\nA claim from a page.\n"),
    });

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

describe("provenance sidecar: no symlink is followed", () => {
  it.skipIf(!canSymlink)(
    "a pushed symlink in place of this machine's sidecar leaves its target untouched",
    async () => {
      const remote = bareRemote();
      const a = await machine();
      await a.store.write("memory/web.md", "# Web\n\nA claim from a page.\n", {
        provenance: "untrusted",
      });
      const gitA = new WorkspaceGit(a.store);
      await gitA.setRemote(remote);
      await gitA.sync();
      const sidecarName = ownSidecar(a).slice(a.workspace.length + 1);

      // Whoever can push to the remote replaces the sidecar with a link to a file outside.
      const outside = join(a.dir, "zshrc");
      writeFileSync(outside, "export KEEP=1\n");
      const attacker = join(a.dir, "attacker");
      git(a.dir, "clone", "-q", "-b", "main", remote, attacker);
      rmSync(join(attacker, sidecarName));
      symlinkSync(outside, join(attacker, sidecarName));
      git(attacker, "add", "-A");
      git(attacker, "commit", "-q", "-m", "link");
      git(attacker, "push", "-q", "origin", "main");

      expect((await gitA.sync()).pulled).toBe(true);
      expect(lstatSync(join(a.workspace, sidecarName)).isSymbolicLink()).toBe(true);
      // The next sync writes the sidecar again: it replaces the link, never writes through it.
      await a.store.write("memory/web2.md", "# Web 2\n\nAnother claim.\n", {
        provenance: "untrusted",
      });
      await gitA.sync();
      expect(readFileSync(outside, "utf8")).toBe("export KEEP=1\n");
      const st = lstatSync(join(a.workspace, sidecarName));
      expect(st.isFile() && !st.isSymbolicLink()).toBe(true);
      const written = JSON.parse(readFileSync(join(a.workspace, sidecarName), "utf8"));
      expect(written.files["memory/web.md"].provenance).toBe("untrusted");
      expect(written.files["memory/web2.md"].provenance).toBe("untrusted");
    },
    60_000,
  );

  it.skipIf(!canSymlink)("a symlinked sidecar file is replaced, not written through", async () => {
    const a = await machine();
    await a.store.write("memory/web.md", "# Web\n\nA claim.\n", { provenance: "untrusted" });
    a.store.writeProvenanceSidecar();
    const sidecar = ownSidecar(a);
    const outside = join(a.dir, "outside.txt");
    writeFileSync(outside, "keep me\n");
    rmSync(sidecar);
    symlinkSync(outside, sidecar);
    a.store.writeProvenanceSidecar();
    expect(readFileSync(outside, "utf8")).toBe("keep me\n");
    expect(lstatSync(sidecar).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(sidecar, "utf8")).files["memory/web.md"].provenance).toBe(
      "untrusted",
    );
  });

  it.skipIf(!canSymlink)("a symlinked .psyche directory is never written into", async () => {
    const a = await machine();
    await a.store.write("memory/web.md", "# Web\n\nA claim.\n", { provenance: "untrusted" });
    a.store.writeProvenanceSidecar();
    const outside = join(a.dir, "outside-dir");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep me\n");
    rmSync(join(a.workspace, ".psyche"), { recursive: true });
    symlinkSync(outside, join(a.workspace, ".psyche"));
    a.store.writeProvenanceSidecar();
    expect(readdirSync(outside)).toEqual(["keep.txt"]);
    expect(lstatSync(join(a.workspace, ".psyche")).isDirectory()).toBe(true);
    expect(existsSync(ownSidecar(a))).toBe(true);
  });

  it.skipIf(!canSymlink)(
    "a symlinked .psyche/provenance directory is never written into",
    async () => {
      const a = await machine();
      await a.store.write("memory/web.md", "# Web\n\nA claim.\n", { provenance: "untrusted" });
      a.store.writeProvenanceSidecar();
      const outside = join(a.dir, "outside-dir");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.txt"), "keep me\n");
      rmSync(sidecarDir(a), { recursive: true });
      symlinkSync(outside, sidecarDir(a));
      a.store.writeProvenanceSidecar();
      expect(readdirSync(outside)).toEqual(["keep.txt"]);
      expect(lstatSync(sidecarDir(a)).isDirectory()).toBe(true);
      expect(existsSync(ownSidecar(a))).toBe(true);
    },
  );

  it.skipIf(!canSymlink)("a symlinked machine.id is replaced by a fresh real id", async () => {
    const a = await machine();
    const outside = join(a.dir, "outside-id");
    writeFileSync(outside, "0123456789abcdef\n");
    mkdirSync(join(a.workspace, ".psyche"), { recursive: true });
    symlinkSync(outside, join(a.workspace, ".psyche", "machine.id"));
    await a.store.write("memory/web.md", "# Web\n\nA claim.\n", { provenance: "untrusted" });
    a.store.writeProvenanceSidecar();
    expect(readFileSync(outside, "utf8")).toBe("0123456789abcdef\n");
    const idFile = join(a.workspace, ".psyche", "machine.id");
    expect(lstatSync(idFile).isSymbolicLink()).toBe(false);
    const id = readFileSync(idFile, "utf8").trim();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toBe("0123456789abcdef");
    expect(readdirSync(sidecarDir(a))).toEqual([`${id}.json`]);
  });

  it.skipIf(!canSymlink)("a symlinked foreign sidecar is not read", async () => {
    const a = await machine();
    const text = "# Pulled\n\nA claim.\n";
    writeFileSync(join(a.workspace, "memory", "pulled.md"), text);
    const files = { "memory/pulled.md": { provenance: "untrusted", sha256: sha256(text) } };
    const outside = join(a.dir, "outside.json");
    writeFileSync(outside, JSON.stringify({ version: 2, files }));
    mkdirSync(sidecarDir(a), { recursive: true });
    symlinkSync(outside, join(sidecarDir(a), `${FOREIGN}.json`));
    await a.store.sync();
    expect(await provenanceOf(a, "memory/pulled.md")).toBe("owner");
    // Control: the same sidecar as a regular file applies.
    rmSync(join(sidecarDir(a), `${FOREIGN}.json`));
    foreignSidecar(a, files);
    await a.store.sync();
    expect(await provenanceOf(a, "memory/pulled.md")).toBe("untrusted");
  });
});

describe("provenance sidecar: content hashes and limits", () => {
  it("a pulled file whose hash matches a foreign untrusted entry is untrusted", async () => {
    const a = await machine();
    const text = "# Pulled\n\nA claim.\n";
    foreignSidecar(a, {
      "memory/pulled.md": { provenance: "untrusted", sha256: sha256(text) },
      "memory/other.md": { provenance: "untrusted", sha256: sha256("different text") },
      "memory/old.md": "untrusted",
    });
    writeFileSync(join(a.workspace, "memory", "pulled.md"), text);
    writeFileSync(join(a.workspace, "memory", "other.md"), "# Other\n\nMine.\n");
    writeFileSync(join(a.workspace, "memory", "old.md"), "# Old\n\nMine.\n");
    await a.store.sync();
    expect(await provenanceOf(a, "memory/pulled.md")).toBe("untrusted");
    // The entry is for other content, and a version 1 entry (no hash) is ignored.
    expect(await provenanceOf(a, "memory/other.md")).toBe("owner");
    expect(await provenanceOf(a, "memory/old.md")).toBe("owner");
  });

  it("an owner rewrite clears the taint even with the stale sidecar on disk", async () => {
    const a = await machine();
    await a.store.write("memory/web.md", "# Web\n\nA claim from a page.\n", {
      provenance: "untrusted",
    });
    a.store.writeProvenanceSidecar();
    // Another machine recorded the same content as untrusted too.
    foreignSidecar(a, {
      "memory/web.md": {
        provenance: "untrusted",
        sha256: sha256("# Web\n\nA claim from a page.\n"),
      },
    });
    // A rewrite that keeps none of the old lines makes the file the owner's.
    await a.store.writeFileAsOwner("memory/web.md", "# Mine\n\nWhat I actually think.\n");
    expect(await provenanceOf(a, "memory/web.md")).toBe("owner");
    await a.store.sync();
    expect(await provenanceOf(a, "memory/web.md")).toBe("owner");
    a.store.writeProvenanceSidecar();
    await a.store.sync();
    expect(await provenanceOf(a, "memory/web.md")).toBe("owner");
    const files = JSON.parse(readFileSync(ownSidecar(a), "utf8")).files;
    expect(files["memory/web.md"]).toBeUndefined();
  });

  it("skips a foreign sidecar over the size cap", async () => {
    const a = await machine();
    const text = "# Pulled\n\nA claim.\n";
    const files = { "memory/pulled.md": { provenance: "untrusted", sha256: sha256(text) } };
    foreignSidecar(a, files, { pad: "x".repeat(4 * 1024 * 1024 + 1) });
    writeFileSync(join(a.workspace, "memory", "pulled.md"), text);
    await a.store.sync();
    expect(await provenanceOf(a, "memory/pulled.md")).toBe("owner");
    // Control: the same entry under the cap applies.
    foreignSidecar(a, files);
    await a.store.sync();
    expect(await provenanceOf(a, "memory/pulled.md")).toBe("untrusted");
  });

  it("never indexes a pulled file whose name the store refuses", async () => {
    const a = await machine();
    writeFileSync(join(a.workspace, "memory", "$(touch PWNED).md"), "# Bad\n");
    writeFileSync(join(a.workspace, "memory", "back`tick`.md"), "# Bad\n");
    writeFileSync(join(a.workspace, "memory", ".hidden.md"), "# Hidden\n");
    writeFileSync(join(a.workspace, "memory", "fine (1).md"), "# Fine\n");
    const { changed } = await a.store.sync();
    expect(changed).toContain("memory/fine (1).md");
    expect(changed.filter((p) => !p.endsWith("fine (1).md") && p.includes("memory/"))).toEqual([]);
    const listed = (await a.store.listFileInfo()).map((f) => f.path);
    expect(listed).toContain("memory/fine (1).md");
    expect(
      listed.some((p) => p.includes("PWNED") || p.includes("`") || p.includes(".hidden")),
    ).toBe(false);
  });
});
