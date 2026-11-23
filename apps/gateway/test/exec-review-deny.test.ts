import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { srtSearchDirs } from "@psyche/sandbox";
import { describe, expect, it } from "vitest";
import {
  execHostSrtSettings,
  gitRepoRoot,
  reviewableRepoRoot,
  reviewedRunDenyWrite,
} from "../src/compose/exec-host.ts";

/**
 * What a run Auto mode's exec reviewer approved may write in its repository (#1546 review: H1
 * `commondir`, H2 nested `.git`, M3 launch config). The deny list is checked twice: against
 * srt's documented macOS matching (a literal is a subpath; a glob is an anchored regex with
 * `**` / `**\/` / `*` / `?` / `[...]`, covering everything below a match), and, when srt is
 * installed, by real writes from inside srt in a temp repository (never the owner's files).
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "psy-xd-")));
const repo = join(root, "work", "app");
mkdirSync(join(repo, ".git"), { recursive: true });
mkdirSync(join(repo, "pkg"), { recursive: true });
writeFileSync(join(repo, ".git", "config"), "[core]\n\tbare = false\n");

/** srt's glob translation (sandbox-runtime `globToRegex` + `denyGlobRegex`). */
function globDeny(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (pattern.startsWith("**/", i)) {
      re += "(.*/)?";
      i += 2;
    } else if (pattern.startsWith("**", i)) {
      re += ".*";
      i += 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = pattern.indexOf("]", i);
      re += `[${pattern.slice(i + 1, end).replace(/[.^$+{}()|\\]/g, "\\$&")}]`;
      i = end;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(/.*)?$`);
}

function denied(list: readonly string[], path: string): boolean {
  return list.some((p) =>
    /[*?[]/.test(p) ? globDeny(p).test(path) : path === p || path.startsWith(`${p}/`),
  );
}

/** Writes a reviewed run must never make: each was a way to run code later (review rows). */
const MUST_DENY = [
  ".git/commondir",
  ".git/hooks/pre-commit",
  ".git/config",
  ".git/config.worktree",
  ".git/info/attributes",
  ".git/modules/x/config",
  ".git/worktrees/x/commondir",
  ".git/rebase-merge/git-rebase-todo",
  ".git/rebase-apply/patch",
  ".git/sequencer/todo",
  ".GIT/hooks/pre-commit",
  ".git/HOOKS/pre-commit",
  "sub/.git",
  "sub/.git/config",
  "sub/deeper/.git/config",
  "sub/deeper/.git/commondir",
  "sub/.GIT/hooks/x",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/commands/x.md",
  "pkg/.claude/settings.json",
  ".cursor/mcp.json",
  "pkg/deep/.cursor/mcp.json",
  ".cargo/config.toml",
  ".cargo/config",
  "x.code-workspace",
  "pkg/y.CODE-WORKSPACE",
  ".vscode/tasks.json",
  ".VSCode/tasks.json",
  "pkg/deep/.vscode/settings.json",
  ".devcontainer/devcontainer.json",
  ".envrc",
  "pkg/deep/.envrc",
  ".npmrc",
  "pkg/.npmrc",
  "lefthook.yml",
  ".husky/pre-commit",
];

/** Writes a build, a test or `git add` / `git commit` makes: still allowed. */
const MUST_ALLOW = [
  "src/ok.txt",
  ".git/index",
  ".git/index.lock",
  ".git/objects/ab/cdef",
  ".git/refs/heads/main",
  ".git/logs/HEAD",
  ".git/COMMIT_EDITMSG",
  ".git/HEAD",
  ".gitignore",
  ".github/workflows/ci.yml",
  "src/.gitkeep",
  "target/debug/app",
  "node_modules/.vite/deps/x.js",
  "coverage/index.html",
  "notes/vscode.md",
  ".npmrc.example",
  "my.code-workspace.md",
];

describe("reviewedRunDenyWrite (srt's macOS matching)", () => {
  const list = reviewedRunDenyWrite(repo, join(repo, "pkg"));

  it.each(MUST_DENY)("denies %s", (p) => {
    expect(denied(list, join(repo, p))).toBe(true);
  });

  it.each(MUST_ALLOW)("allows %s", (p) => {
    expect(denied(list, join(repo, p))).toBe(false);
  });

  it("names the repository's git internals literally too, and launch config at the root and the cwd", () => {
    for (const n of ["commondir", "rebase-merge", "rebase-apply", "sequencer", "hooks"]) {
      expect(list).toContain(join(repo, ".git", n));
    }
    for (const n of [".claude", ".cursor", ".cargo", ".vscode", ".envrc"]) {
      expect(list).toContain(join(repo, n));
      expect(list).toContain(join(repo, "pkg", n));
    }
  });

  it("every glob is rooted at the repository", () => {
    for (const p of list) expect(p.startsWith(`${repo}/`)).toBe(true);
  });
});

describe("which repository roots a reviewed run may write", () => {
  it("a .git with commondir is a redirect: no root, so no review (H1)", () => {
    const r = join(root, "redirected");
    mkdirSync(join(r, ".git"), { recursive: true });
    writeFileSync(join(r, ".git", "config"), "[core]\n");
    expect(gitRepoRoot(r)).toBe(r);
    writeFileSync(join(r, ".git", "commondir"), "../evil\n");
    expect(gitRepoRoot(r)).toBeUndefined();
  });

  it("a .git file (gitdir: elsewhere) at the root is a redirect", () => {
    const r = join(root, "gitfile");
    mkdirSync(r, { recursive: true });
    writeFileSync(join(r, ".git"), "gitdir: ../evil2\n");
    expect(gitRepoRoot(r)).toBeUndefined();
  });

  it("never the owner's home or a folder above it (dotfiles repositories)", () => {
    const home = join(root, "home-dots");
    mkdirSync(join(home, ".git"), { recursive: true });
    mkdirSync(join(home, "src"), { recursive: true });
    writeFileSync(join(home, ".git", "config"), "[core]\n");
    expect(gitRepoRoot(join(home, "src"))).toBe(home);
    expect(reviewableRepoRoot(join(home, "src"), home)).toBeUndefined();
    expect(reviewableRepoRoot(join(home, "src"), join(home, "src"))).toBeUndefined();
    // Control: a repository below the home is reviewable.
    expect(reviewableRepoRoot(repo, root)).toBe(repo);
  });

  it.each(["br[ack]et", "st*r", "q?", "br{a,b}ce"])(
    "never a root srt would read as a glob (%s)",
    (name) => {
      const r = join(root, name);
      mkdirSync(join(r, ".git"), { recursive: true });
      writeFileSync(join(r, ".git", "config"), "[core]\n");
      expect(gitRepoRoot(r)).toBe(r);
      expect(reviewableRepoRoot(r, join(root, "nohome"))).toBeUndefined();
    },
  );
});

/** srt on this Mac, if installed (never installed by the test). */
function findSrt(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  for (const d of srtSearchDirs()) {
    const p = join(d, "srt");
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // next
    }
  }
  return undefined;
}

const srt = findSrt();

describe.skipIf(srt === undefined)("a reviewed run under the real srt", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "psy-xs-")));
  const r = join(base, "repo");
  const psycheHome = join(base, "psyche");
  const scratch = join(psycheHome, "exec-host", "s");
  for (const d of [join(r, ".git", "objects"), join(r, "src"), join(r, "sub", "deeper"), scratch]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(r, ".git", "config"), "[core]\n");
  const settings = join(base, "settings.json");
  writeFileSync(
    settings,
    JSON.stringify(
      execHostSrtSettings({
        psycheHome,
        userHome: join(base, "home"),
        scratch,
        writable: [r],
        allowedDomains: [],
        denyWrite: reviewedRunDenyWrite(r, r),
      }),
    ),
  );
  const write = (rel: string) =>
    spawnSync(
      srt as string,
      [
        "--settings",
        settings,
        "--",
        "/bin/sh",
        "-c",
        'mkdir -p "$(dirname "$1")" && echo x > "$1"',
        "sh",
        join(r, rel),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );

  it("the control write inside the repository succeeds", () => {
    const out = write("src/ok.txt");
    expect(out.status).toBe(0);
    expect(existsSync(join(r, "src", "ok.txt"))).toBe(true);
    expect(write(".git/objects/probe").status).toBe(0);
  });

  it.each([
    ".git/commondir",
    "sub/.git",
    "sub/deeper/.git/config",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".cursor/mcp.json",
    ".cargo/config.toml",
    "x.code-workspace",
  ])("cannot write %s", (rel) => {
    const out = write(rel);
    expect(out.status).not.toBe(0);
    expect(existsSync(join(r, rel))).toBe(false);
  });
});
