import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeProtectedHomeRoots } from "../src/index.ts";
import { call, makeBroker, path } from "./helpers.ts";

const WIN = process.platform === "win32";
const ctx = { threadId: "thr_a", runId: "run_1", permissionMode: "balanced", taint: false };

/**
 * #1427 review r1, findings 4 and 5: writes into an app's launch config are floored destructive
 * like writes under `.git`, and the write-protected home roots cover all of `~/Library`.
 */
describe.skipIf(WIN)("writes whose content runs later", () => {
  const broker = () =>
    makeBroker({
      policy: { folders: [{ path: "/Users/o/Vault", mode: "rw" as const }] },
      hostProgram: { home: "/Users/o" },
    }).broker;

  it.each([
    ["/Users/o/Vault/.obsidian/plugins/x/main.js", "floor:launch_config"],
    ["/Users/o/Vault/.obsidian/community-plugins.json", "floor:launch_config"],
    ["/Users/o/Vault/.vscode/tasks.json", "floor:launch_config"],
    ["/Users/o/Vault/.idea/workspace.xml", "floor:launch_config"],
    ["/Users/o/Vault/.zed/tasks.json", "floor:launch_config"],
    ["/Users/o/Vault/.envrc", "floor:launch_config"],
    ["/Users/o/Vault/.husky/pre-commit", "floor:launch_config"],
    // #1434 review r1, finding 2.
    ["/Users/o/Vault/.devcontainer/devcontainer.json", "floor:launch_config"],
    ["/Users/o/Vault/app.code-workspace", "floor:launch_config"],
    ["/Users/o/Vault/.cursor/mcp.json", "floor:launch_config"],
    ["/Users/o/Vault/.npmrc", "floor:launch_config"],
    ["/Users/o/Vault/.cargo/config.toml", "floor:launch_config"],
    ["/Users/o/Vault/.git/hooks/pre-commit", "floor:git_internals"],
  ])("%s is floored destructive (%s)", async (p, floor) => {
    const d = await broker().decide(call("write_file", "write", path(p)), ctx as never);
    expect(d.sideEffect).toBe("destructive");
    expect(d.trace).toContain(floor);
    expect(d.decision).not.toBe("allow");
  });

  it.each([
    "/Users/o/Vault/notes/vscode.md",
    "/Users/o/Vault/.obsidian-backup.md",
    "/Users/o/Vault/.vscodeignore",
    "/Users/o/Vault/.envrc.example",
    "/Users/o/Vault/.npmrc.example",
    "/Users/o/Vault/docs/.mcp.json.md",
    "/Users/o/Vault/my.code-workspace.md",
  ])("%s stays a plain write", async (p) => {
    const d = await broker().decide(call("write_file", "write", path(p)), ctx as never);
    expect(d.sideEffect).toBe("write");
    expect(d.trace.some((t) => t.startsWith("floor:launch_config"))).toBe(false);
  });

  it("covers a move or copy destination too", async () => {
    const d = await broker().decide(
      call("write_file", "write", path("/Users/o/Vault/notes/a.md"), {
        params: { to: "/Users/o/Vault/.vscode/tasks.json" },
      }),
      ctx as never,
    );
    expect(d.sideEffect).toBe("destructive");
  });
});

describe.skipIf(WIN)("write-protected home roots", () => {
  const home = "/Users/o";
  it("on macOS: all of ~/Library, ~/bin, editor and tool config, and every share refusal", () => {
    const roots = writeProtectedHomeRoots(home, "darwin");
    for (const rel of [
      "Library",
      "bin",
      ".vscode/extensions",
      ".hammerspoon",
      ".config/karabiner",
      ".config/ghostty",
      ".config/nvim",
      ".config/zed",
      ".ssh",
      ".aws",
      ".kube",
      "Applications",
      ".zshrc",
    ]) {
      expect(roots, rel).toContain(join(home, rel));
    }
    expect(roots).not.toContain(home);
    expect(roots).not.toContain(join(home, "Documents"));
  });

  it("elsewhere: the macOS-only entries are left to the platform's own list", () => {
    const linux = writeProtectedHomeRoots(home, "linux");
    expect(linux).toContain(join(home, ".ssh"));
    expect(linux).toContain(join(home, ".zshrc"));
    expect(linux).not.toContain(join(home, "bin"));
    expect(linux).not.toContain(join(home, ".hammerspoon"));
    expect(writeProtectedHomeRoots(home, "win32")).toEqual([]);
  });
});
