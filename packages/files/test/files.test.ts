import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import type { ToolResult } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FileChange,
  type FileToolsOptions,
  fileTools,
  foldPathName,
  type GrantedFolder,
  MemoryFileProvenance,
} from "../src/index.ts";

let root: string;
let granted: string;
let readOnly: string;
let outside: string;
let folders: GrantedFolder[];

const ctx = (over: Partial<ToolRunContext> = {}) =>
  ({ signal: new AbortController().signal, taint: false, ...over }) as ToolRunContext;

function toolset(options: FileToolsOptions = {}) {
  const tools = Object.fromEntries(fileTools(options).map((t) => [t.spec.name, t])) as Record<
    string,
    AgentToolRegistration
  >;
  const run = (name: string, params: unknown, c = ctx()) =>
    tools[name]?.run?.(params, c) as Promise<ToolResult & { output: Record<string, unknown> }>;
  return { tools, run };
}

// The stand-in's behaviour (no folder list: the broker alone confines paths).
let tools: Record<string, AgentToolRegistration>;
let run: ReturnType<typeof toolset>["run"];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "psy-ft-")));
  granted = join(root, "granted");
  readOnly = join(root, "ro");
  outside = join(root, "outside");
  mkdirSync(granted);
  mkdirSync(readOnly);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "vault key");
  writeFileSync(join(readOnly, "notes.md"), "read me");
  folders = [
    { path: granted, mode: "rw" },
    { path: readOnly, mode: "ro" },
  ];
  ({ tools, run } = toolset());
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ported from the Gateway stand-in", () => {
  it("reads and writes a real path", async () => {
    await run("write_file", { path: join(granted, "a.md"), content: "hi" });
    const r = await run("read_file", { path: join(granted, "a.md") });
    expect(r).toMatchObject({ output: { text: "hi" }, provenance: "untrusted" });
  });

  it("refuses to read through a symlinked directory or file", async () => {
    symlinkSync(outside, join(granted, "dir"));
    symlinkSync(join(outside, "secret.txt"), join(granted, "file"));
    await expect(
      run("read_file", { path: join(granted, "dir", "secret.txt") }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(run("read_file", { path: join(granted, "file") })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(run("list_dir", { path: join(granted, "dir") })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("refuses a FIFO at once instead of waiting on its open (review of #1425 r1)", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [join(granted, "pipe")]);
    const started = Date.now();
    await expect(run("read_file", { path: join(granted, "pipe") })).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses to write through a dangling symlink", async () => {
    symlinkSync(join(outside, "new.plist"), join(granted, "x.plist"));
    await expect(
      run("write_file", { path: join(granted, "x.plist"), content: "evil" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(() => readFileSync(join(outside, "new.plist"))).toThrow();
  });

  it("caps reads and binds writes without touching the disk", async () => {
    writeFileSync(join(granted, "big.txt"), "x".repeat(300 * 1024));
    const r = await run("read_file", { path: join(granted, "big.txt") });
    expect(r.output.truncated).toBe(true);
    expect((r.output.text as string).length).toBe(32 * 1024);
    const d = tools.write_file?.describeCall?.({ path: join(granted, "n.md"), content: "a" });
    expect(d).toMatchObject({ kind: "file_write", bindingFields: { operation: "overwrite" } });
    expect(readdirSync(granted)).not.toContain("n.md");
    expect(tools.read_file?.validate?.({ path: "relative.md" })).toBeTruthy();
  });
});

describe("writes into an app's launch config (#1427 review r1, finding 4)", () => {
  it.each([
    ".obsidian/plugins/evil/main.js",
    ".obsidian/community-plugins.json",
    ".vscode/tasks.json",
    ".idea/runConfigurations/run.xml",
    ".zed/tasks.json",
    ".envrc",
    ".husky/pre-commit",
  ])("%s is destructive, and the card names the path", (rel) => {
    const path = join(granted, "Vault", rel);
    for (const d of [
      tools.write_file?.describeCall?.({ path, content: "x" }),
      tools.edit_file?.describeCall?.({ path, old_string: "a", new_string: "b" } as never),
    ]) {
      expect(d?.sideEffect).toBe("destructive");
      expect(d?.details).toMatchObject({ path });
    }
  });

  it.each([
    "notes/vscode.md",
    ".obsidian-backup.md",
    ".vscodeignore",
    ".envrc.example",
    "docs/idea.md",
  ])("%s stays a plain write", (rel) => {
    const d = tools.write_file?.describeCall?.({ path: join(granted, rel), content: "x" });
    expect(d?.sideEffect).toBeUndefined();
  });
});

describe("writes under .git/ (security §5.4)", () => {
  it("are destructive, so the owner always sees the card; other writes stay plain writes", () => {
    const git = tools.write_file?.describeCall?.({
      path: join(granted, "repo", ".git", "config"),
      content: "[core]",
    });
    expect(git?.sideEffect).toBe("destructive");
    const edit = tools.edit_file?.describeCall?.({
      path: join(granted, ".git", "hooks", "pre-commit"),
      old_string: "a",
      new_string: "b",
    } as never);
    expect(edit?.sideEffect).toBe("destructive");
    const plain = tools.write_file?.describeCall?.({ path: join(granted, "n.md"), content: "a" });
    expect(plain?.sideEffect).toBeUndefined();
    // Case-insensitive, as APFS is: `.GIT` is where git looks too.
    for (const dotGit of [".GIT", ".Git"]) {
      expect(
        tools.write_file?.describeCall?.({ path: join(granted, dotGit, "config"), content: "x" })
          ?.sideEffect,
      ).toBe("destructive");
    }
    // A git directory assembled elsewhere (bare repository, --separate-git-dir): once one of
    // HEAD / objects / refs is there, the next entry asks.
    const bare = join(granted, "bare");
    mkdirSync(join(bare, "objects"), { recursive: true });
    for (const entry of ["HEAD", "config", join("refs", "heads", "main")]) {
      expect(
        tools.write_file?.describeCall?.({ path: join(bare, entry), content: "x" })?.sideEffect,
        entry,
      ).toBe("destructive");
    }
    // A file merely named like it is not inside a repository's metadata.
    const named = tools.write_file?.describeCall?.({
      path: join(granted, ".gitignore"),
      content: "a",
    });
    expect(named?.sideEffect).toBeUndefined();
  });
});

describe("side-effect classes and targets", () => {
  it("declares read tools as reads and writes as file_write approvals on the real path", () => {
    expect(Object.keys(tools).sort()).toEqual([
      "edit_file",
      "list_dir",
      "read_file",
      "search_files",
      "write_file",
    ]);
    for (const name of ["read_file", "list_dir", "search_files"]) {
      expect(tools[name]?.spec).toMatchObject({
        sideEffect: "read",
        targetKind: "path",
        provenanceOut: "untrusted",
      });
    }
    for (const name of ["write_file", "edit_file"]) {
      expect(tools[name]?.spec).toMatchObject({ sideEffect: "write", targetKind: "path" });
    }
    const target = tools.read_file?.describeCall?.({ path: `${granted}/../outside/secret.txt` });
    expect(target).toEqual({ target: { kind: "path", value: join(outside, "secret.txt") } });
  });

  it("puts a diff on the edit card and binds the exact edit", () => {
    const p = { path: join(granted, "a.md"), old_string: "teh", new_string: "the" };
    const d = tools.edit_file?.describeCall?.(p);
    expect(d).toMatchObject({
      kind: "file_write",
      target: { kind: "path", value: join(granted, "a.md") },
      bindingFields: { operation: "edit", realPath: join(granted, "a.md") },
      details: { path: join(granted, "a.md"), operation: "edit" },
    });
    expect(d?.details?.diff).toContain("-teh\n+the");
    const other = tools.edit_file?.describeCall?.({ ...p, replace_all: true });
    expect(other?.bindingFields).not.toEqual(d?.bindingFields);
  });
});

describe("traversal and granted folders", () => {
  beforeEach(() => {
    ({ tools, run } = toolset({ folders: () => folders }));
  });

  it("refuses `..` that leaves a granted folder", async () => {
    await expect(
      run("read_file", { path: `${granted}/../outside/secret.txt` }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      run("write_file", { path: `${granted}/sub/../../outside/x.txt`, content: "x" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(run("list_dir", { path: `${granted}/..` })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      run("search_files", { path: `${granted}/../outside`, query: "vault" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
  });

  it("does not treat a sibling with a shared prefix as inside the folder", async () => {
    mkdirSync(`${granted}-evil`);
    writeFileSync(`${granted}-evil/a.txt`, "x");
    await expect(run("read_file", { path: `${granted}-evil/a.txt` })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("allows `..` that stays inside, and refuses writes to a read-only folder", async () => {
    mkdirSync(join(granted, "sub"));
    await run("write_file", { path: `${granted}/sub/../ok.md`, content: "ok" });
    expect(readFileSync(join(granted, "ok.md"), "utf8")).toBe("ok");
    expect((await run("read_file", { path: join(readOnly, "notes.md") })).output.text).toBe(
      "read me",
    );
    await expect(
      run("write_file", { path: join(readOnly, "notes.md"), content: "x" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      run("edit_file", { path: join(readOnly, "notes.md"), old_string: "read", new_string: "x" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("follows the live folder list: a revoked folder is refused", async () => {
    folders = [];
    await expect(run("read_file", { path: join(readOnly, "notes.md") })).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("Psyche's own CLI workdirs", () => {
  it("opens one working directory inside the protected home, and nothing else in it", async () => {
    const home = join(granted, ".psyche");
    const cli = join(home, "cli", "claude-code");
    mkdirSync(cli, { recursive: true });
    mkdirSync(join(home, "vault"));
    writeFileSync(join(cli, "notes.md"), "scratch");
    writeFileSync(join(cli, ".psyche-mcp-1.json"), '{"token":"t"}');
    writeFileSync(join(cli, "CLAUDE.md"), "rules");
    writeFileSync(join(home, "vault", "key.md"), "key");
    folders = [{ path: cli, mode: "rw" }];
    ({ run } = toolset({
      folders: () => folders,
      protectedRoots: () => [home],
      ownDirs: () => [cli],
    }));
    expect((await run("read_file", { path: join(cli, "notes.md") })).output).toBeDefined();
    await run("write_file", { path: join(cli, "out.md"), content: "ok" });
    for (const p of [
      join(cli, ".psyche-mcp-1.json"),
      join(cli, "CLAUDE.md"),
      join(home, "vault", "key.md"),
    ]) {
      await expect(run("read_file", { path: p })).rejects.toMatchObject({
        code: "forbidden",
        details: { reason: "protected_path" },
      });
    }
    await expect(
      run("write_file", { path: join(cli, ".claude", "settings.json"), content: "{}" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // Without the exemption the workdir is as protected as the rest of the home.
    ({ run } = toolset({ folders: () => folders, protectedRoots: () => [home] }));
    await expect(run("read_file", { path: join(cli, "notes.md") })).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("protected locations (#285)", () => {
  it("refuses Psyche's home and credential stores under a granted rw folder", async () => {
    const home = join(granted, ".psyche");
    mkdirSync(join(home, "workspace"), { recursive: true });
    writeFileSync(join(home, "workspace", "MEMORY.md"), "memory");
    mkdirSync(join(granted, ".ssh"));
    writeFileSync(join(granted, ".ssh", "id_rsa"), "key");
    ({ run } = toolset({
      folders: () => folders,
      protectedRoots: () => [home, join(granted, ".ssh")],
    }));
    await expect(
      run("write_file", { path: join(home, "workspace", "MEMORY.md"), content: "x" }),
    ).rejects.toMatchObject({ code: "forbidden", details: { reason: "protected_path" } });
    await expect(run("read_file", { path: join(granted, ".ssh", "id_rsa") })).rejects.toMatchObject(
      { code: "forbidden" },
    );
    await expect(run("list_dir", { path: home })).rejects.toMatchObject({ code: "forbidden" });
    expect(readFileSync(join(home, "workspace", "MEMORY.md"), "utf8")).toBe("memory");
    // Everything else in the granted folder works as before.
    await run("write_file", { path: join(granted, "ok.md"), content: "ok" });
    // Searching or listing the granted ancestor never reaches into them either.
    writeFileSync(join(home, "workspace", "secret.md"), "needle in memory");
    writeFileSync(join(granted, ".ssh", "config"), "needle in ssh");
    writeFileSync(join(granted, "public.md"), "needle in public");
    const found = await run("search_files", {
      path: granted,
      query: "needle",
      include_hidden: true,
    });
    expect(JSON.stringify(found.output)).not.toMatch(/\.ssh|\.psyche/);
    expect(JSON.stringify(found.output)).toContain("public.md");
    const listed = await run("list_dir", { path: granted });
    const names = (listed.output.entries as { name: string }[]).map((e) => e.name);
    expect(names).not.toContain(".psyche");
    expect(names).not.toContain(".ssh");
  });
});

describe("write-protected persistence locations (apps.open review, finding 2)", () => {
  // `granted` stands in for an older home-root rw share: the folders below are its children.
  const persistence = [
    "Applications/Notes.app/Contents/Info.plist",
    "Library/LaunchAgents/com.evil.plist",
    "Library/Preferences/com.apple.Terminal.plist",
    "Library/Services/Run.workflow/Contents/document.wflow",
    "Library/Application Support/com.apple.backgroundtaskmanagementagent/backgrounditems.btm",
    ".zshrc",
    ".zprofile",
    ".zshenv",
    ".zlogin",
    ".bashrc",
    ".bash_profile",
    ".profile",
    ".config/fish/config.fish",
    ".gitconfig",
    ".ssh/authorized_keys",
  ];
  const writeRoots = () => [
    ...[
      "Applications",
      "Library/LaunchAgents",
      "Library/Preferences",
      "Library/Services",
      "Library/Application Support/com.apple.backgroundtaskmanagementagent",
      ".zshrc",
      ".zprofile",
      ".zshenv",
      ".zlogin",
      ".bashrc",
      ".bash_profile",
      ".profile",
      ".config/fish",
      ".gitconfig",
      ".ssh",
    ].map((rel) => join(granted, rel)),
  ];

  it.each(persistence)("refuses a write to ~/%s under a granted rw folder", async (rel) => {
    const path = join(granted, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "before");
    ({ run } = toolset({ folders: () => folders, writeProtectedRoots: writeRoots }));
    await expect(run("write_file", { path, content: "after" })).rejects.toMatchObject({
      code: "forbidden",
      details: { reason: "protected_path", access: "write" },
    });
    await expect(
      run("edit_file", { path, old_string: "before", new_string: "after" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(readFileSync(path, "utf8")).toBe("before");
    // Reading there follows the grant as before.
    const read = await run("read_file", { path });
    expect(JSON.stringify(read.output)).toContain("before");
  });

  it("refuses a new file there and another spelling of the folder, and leaves near names alone", async () => {
    ({ run } = toolset({ folders: () => folders, writeProtectedRoots: writeRoots }));
    mkdirSync(join(granted, "Library", "LaunchAgents"), { recursive: true });
    await expect(
      run("write_file", { path: join(granted, "Library/LaunchAgents/new.plist"), content: "x" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    if (process.platform === "darwin") {
      // APFS ignores case by default: the same folder.
      await expect(
        run("write_file", { path: join(granted, "library/launchagents/new.plist"), content: "x" }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    // Near misses: a sibling with a shared prefix, a backup of an rc file, another app folder.
    for (const rel of [".zshrc.bak", "Applications-notes/a.md", "Projects/.gitconfig.md"]) {
      const path = join(granted, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      const done = await run("write_file", { path, content: "ok" });
      expect(done.isError).toBeUndefined();
    }
  });
});

describe("a share of the whole home folder (#1427 review r1, finding 5)", () => {
  // `granted` stands in for the owner's home, shared read-write by an older grant.
  const protection = () => ({
    roots: ["Library", ".vscode/extensions", ".hammerspoon", ".config/nvim"].map((rel) =>
      join(granted, rel),
    ),
    dotHome: granted,
  });
  const write = (rel: string) =>
    run("write_file", { path: join(granted, rel), content: "x" }).then(
      (r) => r.isError ?? false,
      (e: { code?: string }) => e.code ?? "error",
    );

  beforeEach(() => {
    ({ run } = toolset({ folders: () => folders, writeProtectedRoots: protection }));
  });

  it.each([
    "Library/Python/3.12/lib/python/site-packages/evil.pth",
    "Library/QuickLook/x.qlgenerator/Contents/Info.plist",
    "Library/Application Support/Code/User/settings.json",
    "library/mail/bundles/x.plist",
    ".vscode/extensions/evil/package.json",
    ".hammerspoon/init.lua",
    ".config/nvim/init.lua",
    // Any dot entry directly in home, existing or not.
    ".newrc",
    ".tool/config.json",
    ".vimrc",
    ".tmux.conf",
    ".ipython/profile_default/startup/x.py",
    ".ſsh/config",
  ])("refuses writing ~/%s", async (rel) => {
    if (rel.startsWith("library/") && process.platform === "linux") return;
    mkdirSync(join(granted, rel, ".."), { recursive: true });
    expect(await write(rel)).toBe("forbidden");
  });

  it.each([
    "notes.md",
    "Documents/plan.txt",
    "Projects/app/.env",
    "Projects/app/.gitignore",
    "Projects/app/src/.eslintrc.json",
    "Libraryish/notes.md",
  ])("still writes ~/%s", async (rel) => {
    mkdirSync(join(granted, rel, ".."), { recursive: true });
    expect(await write(rel)).toBe(false);
  });

  it("leaves a dot folder the owner shared by itself to its own grant", async () => {
    const dotfiles = join(granted, ".dotfiles");
    mkdirSync(dotfiles);
    folders.push({ path: dotfiles, mode: "rw" });
    expect(await write(".dotfiles/zshrc")).toBe(false);
    // Without that share, the home share's rule applies.
    folders.pop();
    expect(await write(".dotfiles/zshrc")).toBe("forbidden");
  });
});

describe("other spellings of a write-protected name (review r1, finding 1)", () => {
  // `granted` stands in for an older home-root share again.
  const writeRoots = () =>
    [
      ".zshrc",
      ".zshenv",
      ".profile",
      ".bash_profile",
      ".gitconfig",
      "Library/LaunchAgents",
      ".config/fish",
      "Café",
      "Kit",
      ".ssh",
    ].map((rel) => join(granted, rel));
  const setup = () => {
    for (const rel of [".zshrc", ".profile", ".bash_profile", ".gitconfig"]) {
      writeFileSync(join(granted, rel), "before");
    }
    mkdirSync(join(granted, "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(join(granted, ".config", "fish"), { recursive: true });
    mkdirSync(join(granted, "Café"));
    mkdirSync(join(granted, "Kit"));
    ({ run } = toolset({ folders: () => folders, writeProtectedRoots: writeRoots }));
  };

  it("folds names as APFS does: compatibility forms, case and NFD", () => {
    expect(foldPathName(".zſhrc")).toBe(".zshrc");
    expect(foldPathName(".proﬁle")).toBe(".profile");
    expect(foldPathName("Kit")).toBe("kit");
    expect(foldPathName("Café")).toBe(foldPathName("Café"));
    expect(foldPathName(".BASH_PROFILE")).toBe(".bash_profile");
    expect(foldPathName("Straße")).toBe("strasse");
    expect(foldPathName(".ẞh")).toBe(".ssh");
    expect(foldPathName("STRAẞE")).toBe("strasse");
    expect(foldPathName(".zshrc2")).not.toBe(".zshrc");
  });

  it.skipIf(process.platform !== "darwin").each([
    ".zſhrc",
    ".zſhenv",
    ".proﬁle",
    ".baſh_proﬁle",
    ".gitconﬁg",
    ".ZSHRC",
    // Review r2: APFS reads `ẞ` as `ss`; `~/.ssh` does not exist yet here.
    ".ẞh/config",
    ".SSH/config",
    "Library/LaunchAgentſ/x.plist",
    "library/launchagents/x.plist",
    ".config/ﬁsh/config.fish",
    "Café/x.txt",
    "Kit/x.txt",
  ])("refuses writing %s", async (rel) => {
    setup();
    const path = join(granted, rel);
    await expect(run("write_file", { path, content: "PWNED" })).rejects.toMatchObject({
      code: "forbidden",
      details: { reason: "protected_path" },
    });
    for (const f of [".zshrc", ".profile", ".bash_profile", ".gitconfig"]) {
      expect(readFileSync(join(granted, f), "utf8"), f).toBe("before");
    }
  });

  it.each([
    ".zshrc2",
    ".zsh_history",
    ".profile.d/notes.md",
    "ſomething.txt",
    "notes-ﬁnal.md",
    "Cafeteria/x.txt",
    "Kitchen/x.txt",
    "Straße.md",
    "İnbox.md",
    ".ssh-notes/x.md",
  ])("still writes %s", async (rel) => {
    setup();
    const path = join(granted, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    const done = await run("write_file", { path, content: "ok" });
    expect(done.isError).toBeUndefined();
  });

  it("refuses a write to another name of the same file (a hard link)", async () => {
    setup();
    const other = join(granted, "Projects", "innocent.txt");
    mkdirSync(join(granted, "Projects"));
    linkSync(join(granted, ".zshrc"), other);
    await expect(run("write_file", { path: other, content: "PWNED" })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(readFileSync(join(granted, ".zshrc"), "utf8")).toBe("before");
  });
});

describe("symlinks", () => {
  it("refuses edits and searches through links, and never searches into one", async () => {
    symlinkSync(join(outside, "secret.txt"), join(granted, "link.txt"));
    await expect(
      run("edit_file", { path: join(granted, "link.txt"), old_string: "vault", new_string: "x" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("vault key");
    symlinkSync(outside, join(granted, "out"));
    const r = await run("search_files", { path: granted, query: "vault" });
    expect(r.output.matches).toEqual([]);
    await expect(
      run("search_files", { path: join(granted, "out"), query: "vault" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses writes under a symlinked parent, even to a new folder", async () => {
    symlinkSync(outside, join(granted, "out"));
    await expect(
      run("write_file", { path: join(granted, "out", "new", "x.md"), content: "x" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
  });

  it("replaces a hard link instead of writing through it", async () => {
    linkSync(join(outside, "secret.txt"), join(granted, "hard.txt"));
    await run("write_file", { path: join(granted, "hard.txt"), content: "new" });
    expect(readFileSync(join(granted, "hard.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("vault key");
  });
});

describe("edit_file", () => {
  const file = () => join(granted, "doc.md");
  beforeEach(() => writeFileSync(file(), "alpha beta\nalpha gamma\n"));

  it("replaces exactly one match and reports both hashes", async () => {
    const r = await run("edit_file", { path: file(), old_string: "beta", new_string: "BETA" });
    expect(readFileSync(file(), "utf8")).toBe("alpha BETA\nalpha gamma\n");
    expect(r.output).toMatchObject({ replacements: 1 });
    expect(r.output.sha256).not.toBe(r.output.previousSha256);
    expect(readdirSync(granted)).toEqual(["doc.md"]);
  });

  it("refuses an ambiguous match unless replace_all", async () => {
    await expect(
      run("edit_file", { path: file(), old_string: "alpha", new_string: "A" }),
    ).rejects.toMatchObject({ code: "conflict" });
    const r = await run("edit_file", {
      path: file(),
      old_string: "alpha",
      new_string: "$&A",
      replace_all: true,
    });
    expect(r.output.replacements).toBe(2);
    expect(readFileSync(file(), "utf8")).toBe("$&A beta\n$&A gamma\n");
  });

  it("reports a conflict when the text is gone or the file changed since it was read", async () => {
    await expect(
      run("edit_file", { path: file(), old_string: "delta", new_string: "x" }),
    ).rejects.toMatchObject({ code: "conflict" });
    const read = await run("read_file", { path: file() });
    writeFileSync(file(), "alpha beta\nalpha gamma\nedited elsewhere\n");
    await expect(
      run("edit_file", {
        path: file(),
        old_string: "beta",
        new_string: "x",
        expected_sha256: read.output.sha256,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(readFileSync(file(), "utf8")).toContain("edited elsewhere");
    await expect(
      run("edit_file", { path: file(), old_string: "beta", new_string: "beta" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      run("edit_file", { path: join(granted, "missing.md"), old_string: "a", new_string: "b" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("limits and paging", () => {
  it("pages a large file without splitting characters", async () => {
    const text = `${"é".repeat(200 * 1024)}end`;
    writeFileSync(join(granted, "u.txt"), text);
    const a = await run("read_file", { path: join(granted, "u.txt") });
    expect(a.output.truncated).toBe(true);
    let got = String(a.output.text);
    let last = a;
    while (last.output.nextOffset !== undefined) {
      last = await run("read_file", {
        path: join(granted, "u.txt"),
        offset: last.output.nextOffset,
      });
      got += String(last.output.text);
    }
    expect(got).toBe(text);
    expect(last.output.truncated).toBe(false);
    expect(a.output.sha256).toBe(last.output.sha256);
  });

  it("flags binary files and refuses oversized writes", async () => {
    writeFileSync(join(granted, "b.bin"), Buffer.from([1, 0, 2]));
    expect((await run("read_file", { path: join(granted, "b.bin") })).output).toMatchObject({
      binary: true,
      text: "",
    });
    await expect(
      run("write_file", { path: join(granted, "big.md"), content: "é".repeat(600 * 1024) }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("lists with kinds, sizes and pages", async () => {
    writeFileSync(join(granted, "a.txt"), "abc");
    mkdirSync(join(granted, "d"));
    symlinkSync(outside, join(granted, "l"));
    const r = await run("list_dir", { path: granted });
    expect(r.output).toMatchObject({
      total: 3,
      entries: [
        { name: "a.txt", kind: "file", size: 3 },
        { name: "d", kind: "dir" },
        { name: "l", kind: "link" },
      ],
    });
    expect((await run("list_dir", { path: granted, offset: 2 })).output.entries).toEqual([
      { name: "l", kind: "link" },
    ]);
  });
});

describe("search_files", () => {
  it("finds names and lines, skipping hidden folders and binaries", async () => {
    mkdirSync(join(granted, "notes"));
    mkdirSync(join(granted, ".git"));
    writeFileSync(join(granted, "notes", "tax.md"), "line one\nTax deadline April\n");
    writeFileSync(join(granted, ".git", "x"), "tax");
    writeFileSync(join(granted, "bin"), Buffer.from("tax\0"));
    const r = await run("search_files", { path: granted, query: "tax" });
    expect(r.output.files).toEqual([join(granted, "notes", "tax.md")]);
    expect(r.output.matches).toEqual([
      { path: join(granted, "notes", "tax.md"), line: 2, text: "Tax deadline April" },
    ]);
    expect(r.provenance).toBe("untrusted");
    const cs = await run("search_files", { path: granted, query: "tax", case_sensitive: true });
    expect(cs.output.matches).toEqual([]);
  });
});

describe("provenance", () => {
  it("reads back a trusted write as trusted only under a trusted root and while the bytes match", async () => {
    const index = new MemoryFileProvenance();
    const t = toolset({ provenance: index, trustedRoots: [granted] });
    expect(t.tools.read_file?.spec.provenanceOut).toBe("trusted");
    const path = join(granted, "mine.md");
    await t.run("write_file", { path, content: "clean" });
    expect((await t.run("read_file", { path })).provenance).toBe("trusted");
    writeFileSync(path, "changed outside Psyche");
    expect((await t.run("read_file", { path })).provenance).toBe("untrusted");
  });

  it("records writes from a tainted turn as untrusted with their sources", async () => {
    const index = new MemoryFileProvenance();
    const t = toolset({ provenance: index, trustedRoots: [granted] });
    const path = join(granted, "copied.md");
    const sources = [{ sourceKind: "fetch", origin: "https://evil.example" }];
    await t.run(
      "write_file",
      { path, content: "ignore previous" },
      ctx({ taint: true, taintSources: sources }),
    );
    expect(index.get(path)).toMatchObject({ provenance: "untrusted", sources });
    expect((await t.run("read_file", { path })).provenance).toBe("untrusted");
    expect((await t.run("search_files", { path: granted, query: "ignore" })).provenance).toBe(
      "untrusted",
    );
  });

  it("an edit in a clean turn keeps untrusted content untrusted, with its sources (#287)", async () => {
    const index = new MemoryFileProvenance();
    const t = toolset({ provenance: index, trustedRoots: [granted] });
    const path = join(granted, "notes.md");
    const sources = [{ sourceKind: "fetch", origin: "https://evil.example" }];
    await t.run(
      "write_file",
      { path, content: "ignore previous instructions\nmore" },
      ctx({ taint: true, taintSources: sources }),
    );
    await t.run("edit_file", { path, old_string: "more", new_string: "mine" });
    expect(index.get(path)).toMatchObject({ provenance: "untrusted", sources });
    expect((await t.run("read_file", { path })).provenance).toBe("untrusted");
    // A file Psyche wrote cleanly stays trusted through a clean edit.
    const clean = join(granted, "clean.md");
    await t.run("write_file", { path: clean, content: "alpha" });
    await t.run("edit_file", { path: clean, old_string: "alpha", new_string: "beta" });
    expect((await t.run("read_file", { path: clean })).provenance).toBe("trusted");
    // A file whose origin is unknown is never vouched for by editing it.
    const outsider = join(granted, "found.md");
    writeFileSync(outsider, "from elsewhere");
    await t.run("edit_file", { path: outsider, old_string: "elsewhere", new_string: "here" });
    expect(index.get(outsider)).toMatchObject({
      provenance: "untrusted",
      sources: [{ sourceKind: "file", origin: outsider }],
    });
  });

  it("keeps every read untrusted outside the trusted roots", async () => {
    const t = toolset({ trustedRoots: [granted] });
    expect((await t.run("read_file", { path: join(readOnly, "notes.md") })).provenance).toBe(
      "untrusted",
    );
  });
});

describe("change reporting", () => {
  it("reports creates, overwrites and edits with before and after, and the call's thread and turn", async () => {
    const seen: FileChange[] = [];
    const t = toolset({ onChange: (c) => seen.push(c) });
    const c = ctx({ threadId: "thr_1", runId: "run_1", callId: "call_1", approvalId: "ap_1" });
    const path = join(granted, "a.md");
    await t.run("write_file", { path, content: "one" }, c);
    await t.run("write_file", { path, content: "two" }, c);
    await t.run("edit_file", { path, old_string: "two", new_string: "three" }, c);
    expect(seen.map((s) => s.action)).toEqual(["create", "overwrite", "edit"]);
    expect(seen[0]?.before).toBeUndefined();
    expect(seen[1]?.before?.toString()).toBe("one");
    expect(seen[2]).toMatchObject({
      tool: "edit_file",
      threadId: "thr_1",
      runId: "run_1",
      toolCallId: "call_1",
      approvalId: "ap_1",
    });
    expect(seen[2]?.before?.toString()).toBe("two");
    expect(seen[2]?.after.toString()).toBe("three");
  });

  it("reports nothing for a refused write", async () => {
    const seen: FileChange[] = [];
    const t = toolset({ onChange: (c) => seen.push(c), folders: () => folders });
    await expect(
      t.run("write_file", { path: join(readOnly, "x.md"), content: "no" }),
    ).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe("a document write never leaves a runnable file (#1333 routine writes)", () => {
  const modeOf = (p: string) => statSync(p).mode & 0o777;

  it("drops the exec bits of an executable document it overwrites or edits", async () => {
    const doc = join(granted, "notes.md");
    writeFileSync(doc, "old hi");
    chmodSync(doc, 0o755);
    await run("write_file", { path: doc, content: "#!/bin/sh\necho hi\n" });
    expect(modeOf(doc) & 0o111).toBe(0);
    chmodSync(doc, 0o755);
    await run("edit_file", { path: doc, old_string: "echo hi", new_string: "echo hello" });
    expect(modeOf(doc) & 0o111).toBe(0);
  });

  it("positive control: a script (not a routine document) keeps its mode", async () => {
    const script = join(granted, "run.sh");
    writeFileSync(script, "old");
    chmodSync(script, 0o755);
    await run("write_file", { path: script, content: "#!/bin/sh\n" });
    expect(modeOf(script)).toBe(0o755);
  });
});

describe("read_file paging", () => {
  it("reading a 600 KB file page by page covers every byte exactly once", async () => {
    // Quotes, backslashes and multi-byte text grow when JSON-escaped: the worst case.
    const line = 'say "héllo" \\ wörld ✓\n';
    let body = "";
    while (Buffer.byteLength(body) < 600 * 1024) body += line;
    writeFileSync(join(granted, "paged.txt"), body);
    const chunks: string[] = [];
    let offset = 0;
    for (let pages = 0; pages < 100; pages++) {
      const r = await run("read_file", { path: join(granted, "paged.txt"), offset });
      const text = r.output.text as string;
      // What the loop's 50,000-character cap sees must fit whole.
      expect(JSON.stringify(r.output).length).toBeLessThan(50_000);
      chunks.push(text);
      if (r.output.nextOffset === undefined) break;
      expect(r.output.nextOffset).toBe(offset + Buffer.byteLength(text));
      offset = r.output.nextOffset as number;
    }
    expect(chunks.join("")).toBe(body);
  });
});

describe("read_file budget", () => {
  it("sizes pages to the configured result budget, whole output included", async () => {
    const body = 'q"\n\t'.repeat(30_000);
    writeFileSync(join(granted, "b.txt"), body);
    const budget = 10_000;
    let offset = 0;
    let got = "";
    for (let i = 0; i < 200; i++) {
      const r = await run(
        "read_file",
        { path: join(granted, "b.txt"), offset },
        ctx({ resultBudgetChars: budget }),
      );
      expect(JSON.stringify(r.output).length).toBeLessThanOrEqual(budget);
      got += String(r.output.text);
      if (r.output.nextOffset === undefined) break;
      offset = r.output.nextOffset as number;
    }
    expect(got).toBe(body);
  });
});

describe("read_file shrink loop", () => {
  it("returns when no cut fits the budget (fields alone over it), instead of spinning", async () => {
    // Control characters escape to six characters each: the path alone outgrows a small budget.
    const dir = join(granted, "\u0001".repeat(200), "\u0002".repeat(200));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "f.txt"), "abcdefgh".repeat(1_000));
    const r = await run("read_file", { path: join(dir, "f.txt") }, ctx({ resultBudgetChars: 100 }));
    expect(r.output.truncated).toBe(true);
    expect(r.output.nextOffset as number).toBeGreaterThan(0);
  });

  it("describes document pages by what one call actually returns", () => {
    const d = tools.read_file?.spec.description ?? "";
    expect(d).not.toMatch(/about 6\dk characters/);
    expect(d).toContain("up to 40k characters per call");
  });
});
