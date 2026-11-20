import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findLaunchConfig, launchConfigEntry, launchConfigLinkTargets } from "../src/index.ts";

/** App settings in a shared folder that the next app launch runs (#1427 review r1, finding 4). */
describe("launchConfigEntry", () => {
  it.each([
    ["/Users/me/Vault/.obsidian/plugins/x/main.js", ".obsidian"],
    ["/Users/me/Vault/.obsidian/community-plugins.json", ".obsidian"],
    ["/Users/me/Vault/.obsidian", ".obsidian"],
    ["/Users/me/app/.vscode/tasks.json", ".vscode"],
    ["/Users/me/app/.vscode/settings.json", ".vscode"],
    ["/Users/me/app/.VSCode/tasks.json", ".vscode"],
    ["/Users/me/app/packages/web/.vscode/launch.json", ".vscode"],
    ["/Users/me/app/.idea/workspace.xml", ".idea"],
    ["/Users/me/app/.idea/runConfigurations/x.xml", ".idea"],
    ["/Users/me/app/.zed/tasks.json", ".zed"],
    ["/Users/me/app/.envrc", ".envrc"],
    ["/Users/me/app/.ENVRC", ".envrc"],
    ["/Users/me/app/.husky/pre-commit", ".husky"],
    ["/Users/me/app/.husky/_/husky.sh", ".husky"],
    // Other spellings APFS folds onto the same name.
    ["/Users/me/app/.vſcode/tasks.json", ".vscode"],
    ["/Users/me/app/.huſky/pre-push", ".husky"],
    ["C:\\Users\\me\\app\\.vscode\\tasks.json", ".vscode"],
    // #1434 review r1, finding 2: read when an app or agent opens the folder...
    ["/Users/me/app/.devcontainer/devcontainer.json", ".devcontainer"],
    ["/Users/me/app/.devcontainer", ".devcontainer"],
    ["/Users/me/app/app.code-workspace", "app.code-workspace"],
    ["/Users/me/app/My App.CODE-WORKSPACE", "my app.code-workspace"],
    ["/Users/me/app/.claude/settings.json", ".claude/settings.json"],
    ["/Users/me/app/.claude/settings.local.json", ".claude/settings.local.json"],
    ["/Users/me/app/.mcp.json", ".mcp.json"],
    ["/Users/me/app/.cursor/mcp.json", ".cursor/mcp.json"],
    ["/Users/me/app/.nvim.lua", ".nvim.lua"],
    ["/Users/me/app/.exrc", ".exrc"],
    // ...or by the next command run there.
    ["/Users/me/app/.pre-commit-config.yaml", ".pre-commit-config.yaml"],
    ["/Users/me/app/lefthook.yml", "lefthook.yml"],
    ["/Users/me/app/.yarnrc.yml", ".yarnrc.yml"],
    ["/Users/me/app/.npmrc", ".npmrc"],
    ["/Users/me/app/packages/web/.NPMRC", ".npmrc"],
    ["/Users/me/app/.pnpmfile.cjs", ".pnpmfile.cjs"],
    ["/Users/me/app/.cargo/config.toml", ".cargo/config.toml"],
    ["/Users/me/app/.cargo/config", ".cargo/config"],
  ])("%s writes into %s", (path, entry) => {
    expect(launchConfigEntry(path)).toBe(entry);
  });

  it.each([
    "/Users/me/notes/vscode.md",
    "/Users/me/Vault/.obsidian-backup.md",
    "/Users/me/Vault/obsidian/plugins/main.js",
    "/Users/me/app/.vscodeignore",
    "/Users/me/app/.vscode-test.mjs",
    "/Users/me/app/.idea.md",
    "/Users/me/app/.envrc.example",
    "/Users/me/app/envrc",
    "/Users/me/app/docs/.envrc/notes.md",
    "/Users/me/app/.husky-notes/x.md",
    "/Users/me/app/src/zed.ts",
    "/Users/me/app/README.md",
    "/Users/me/app/devcontainer.json",
    "/Users/me/app/.devcontainer.md",
    "/Users/me/app/my.code-workspace.md",
    "/Users/me/app/.code-workspace",
    "/Users/me/app/docs/code-workspace.md",
    "/Users/me/app/.claude/commands/x.md",
    "/Users/me/app/.claude/agents/settings.json",
    "/Users/me/app/claude/settings.json",
    "/Users/me/app/settings.json",
    "/Users/me/app/.mcp.json.md",
    "/Users/me/app/docs/.mcp.json.md",
    "/Users/me/app/mcp.json",
    "/Users/me/app/.cursor/rules/x.mdc",
    "/Users/me/app/cursor/mcp.json",
    "/Users/me/app/.nvim.lua.bak",
    "/Users/me/app/.exrc.md",
    "/Users/me/app/pre-commit-config.yaml",
    "/Users/me/app/lefthook.yml.md",
    "/Users/me/app/.yarnrc",
    "/Users/me/app/.yarn/releases/yarn.cjs",
    "/Users/me/app/.npmrc.example",
    "/Users/me/app/docs/npmrc.md",
    "/Users/me/app/.pnpmfile.cjs.bak",
    "/Users/me/app/.cargo/registry/cache/x.crate",
    "/Users/me/app/cargo/config.toml",
    "/Users/me/app/config.toml",
    "/Users/me/app/.npmrc/x",
  ])("%s is an ordinary file", (path) => {
    expect(launchConfigEntry(path)).toBeUndefined();
  });
});

describe("finding launch config in a folder tree", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tree = (files: string[]) => {
    const root = mkdtempSync(join(tmpdir(), "psyche-launch-"));
    dirs.push(root);
    for (const f of files) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), "x");
    }
    return root;
  };

  it("reports each entry once, without walking into it, .git or node_modules", async () => {
    const root = tree([
      ".vscode/settings.json",
      ".vscode/nested/.idea/x.xml",
      "packages/web/.npmrc",
      ".claude/settings.json",
      ".claude/commands/x.md",
      ".git/hooks/pre-commit",
      ".git/.vscode/x",
      "node_modules/pkg/.npmrc",
      "target/debug/.vscode/x.json",
      "app/.build/.npmrc",
      "ios/Pods/x/.npmrc",
      ".claude/worktrees/agent-1/.vscode/settings.json",
      "src/index.ts",
    ]);
    const scan = await findLaunchConfig(root);
    expect(scan.complete).toBe(true);
    expect(scan.found.map((f) => [f.rel, f.kind]).sort()).toEqual([
      [".claude/settings.json", "file"],
      [".vscode", "dir"],
      ["packages/web/.npmrc", "file"],
    ]);
  });

  it("reports nested repositories' .git when asked, never the root's, never walked", async () => {
    const root = tree([
      ".git/config",
      "vendor/lib/.git/config",
      "vendor/lib/.git/.vscode/x",
      "a.md",
    ]);
    expect((await findLaunchConfig(root)).found).toEqual([]);
    expect((await findLaunchConfig(root, { nestedGit: true })).found).toEqual([
      { rel: "vendor/lib/.git", kind: "dir", git: true },
    ]);
  });

  it("reports a link as a link, and says when a limit stopped the walk", async () => {
    const root = tree(["a/b/c/d/x.txt"]);
    const target = tree(["obsidian/app.json"]);
    symlinkSync(join(target, "obsidian"), join(root, ".obsidian"));
    const scan = await findLaunchConfig(root);
    expect(scan.found).toEqual([
      { rel: ".obsidian", kind: "link", linkTarget: join(target, "obsidian") },
    ]);
    expect((await findLaunchConfig(root, { maxDirs: 2 })).complete).toBe(false);
  });

  it("finds where a symlinked config folder really is (a dotfiles repo)", () => {
    const vault = tree(["Notes/a.md"]);
    const dotfiles = tree(["obsidian/plugins/x/main.js", "nvim/init.lua"]);
    symlinkSync(join(dotfiles, "obsidian"), join(vault, ".obsidian"));
    symlinkSync(join(dotfiles, "nvim"), join(vault, "Notes", "nvim-link"));
    const targets = launchConfigLinkTargets([vault]);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.endsWith("/obsidian")).toBe(true);
  });
});
