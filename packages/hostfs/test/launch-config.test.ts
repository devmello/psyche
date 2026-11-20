import { describe, expect, it } from "vitest";
import { launchConfigEntry } from "../src/index.ts";

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
  ])("%s is an ordinary file", (path) => {
    expect(launchConfigEntry(path)).toBeUndefined();
  });
});
