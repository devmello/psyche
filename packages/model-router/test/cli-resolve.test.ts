import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accumulate,
  CliAdapter,
  claudeCodeDialect,
  probeEndpoint,
  resolveCli,
} from "../src/index.ts";

/**
 * #530: under launchd the Gateway's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`, so a CLI that only
 * lives in a Homebrew or user directory must still be found, run and shown in Settings.
 */

const FAKE = resolve(import.meta.dirname, "fake-cli/fake-cli.mjs");
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const clock = { now: () => Date.parse("2026-10-20T08:00:00Z") };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "psyche-cli-resolve-"));
});
// Windows cannot remove a directory that is still a process's cwd: the CLI exits once its stdin's
// end is flushed, which needs the event loop, so retry asynchronously.
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));

/**
 * A `claude` in `dir/<sub>` that runs the fake CLI with this Node (no `node` on PATH needed). On
 * Windows, what npm installs: a `claude.cmd` shim (cmd-shim's layout) whose package script loads
 * the fake CLI; the adapter must run that script with Node, not the shim through `cmd.exe`.
 */
function install(sub: string, name = "claude"): string {
  const bin = join(dir, sub);
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    const pkg = join(bin, "node_modules", "fake-cli");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "cli.js"), `import(${JSON.stringify(pathToFileURL(FAKE).href)});\n`);
    const path = join(bin, `${name}.cmd`);
    writeFileSync(
      path,
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        "",
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ") ELSE (",
        '  SET "_prog=node"',
        "  SET PATHEXT=%PATHEXT:;.JS;=;%",
        ")",
        "",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-cli\\cli.js" %*',
        "",
      ].join("\r\n"),
    );
    return path;
  }
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("finding the subscription CLIs (#530)", () => {
  it("finds a CLI that is only in a Homebrew-like directory, with launchd's PATH", async () => {
    const path = install("homebrew/bin");
    expect(
      await resolveCli("claude", {
        env: { PATH: LAUNCHD_PATH, HOME: join(dir, "home") },
        knownDirs: [join(dir, "homebrew", "bin")],
        loginShell: false,
      }),
    ).toEqual({ path, source: "known_dir" });
  });

  it("finds one in ~/.local/bin of the owner's home (the real directory list)", async () => {
    const home = join(dir, "home");
    // A name no machine has, so the host's own /opt/homebrew/bin cannot answer first.
    const path = install("home/.local/bin", "psyche-test-cli");
    expect(
      await resolveCli("psyche-test-cli", {
        env: { PATH: LAUNCHD_PATH, HOME: home },
        loginShell: false,
      }),
    ).toEqual({ path, source: "known_dir" });
  });

  it("prefers PSYCHE_CLAUDE_PATH, then PATH, then the known directories", async () => {
    const pinned = install("pinned");
    const onPath = install("onpath");
    install("homebrew/bin");
    const opts = { knownDirs: [join(dir, "homebrew", "bin")], loginShell: false } as const;
    expect(
      await resolveCli("claude", {
        ...opts,
        env: { PATH: join(dir, "onpath"), PSYCHE_CLAUDE_PATH: pinned },
      }),
    ).toEqual({ path: pinned, source: "env" });
    expect(await resolveCli("claude", { ...opts, env: { PATH: join(dir, "onpath") } })).toEqual({
      path: onPath,
      source: "path",
    });
  });

  // Windows has no login-shell lookup: a GUI app already inherits the owner's PATH.
  it.skipIf(process.platform === "win32")(
    "asks the login shell last, keeping only an absolute executable path",
    async () => {
      const path = install("only-in-zprofile");
      const shell = join(dir, "fake-zsh");
      writeFileSync(shell, `#!/bin/sh\necho "Welcome!"\necho "${path}"\n`);
      chmodSync(shell, 0o755);
      expect(
        await resolveCli("claude", {
          env: { PATH: LAUNCHD_PATH, HOME: join(dir, "h") },
          knownDirs: [],
          shell,
        }),
      ).toEqual({ path, source: "login_shell" });

      const slow = join(dir, "slow-zsh");
      writeFileSync(slow, "#!/bin/sh\nsleep 5\n");
      chmodSync(slow, 0o755);
      expect(
        await resolveCli("claude", {
          env: { PATH: LAUNCHD_PATH, HOME: join(dir, "h") },
          knownDirs: [],
          shell: slow,
          timeoutMs: 100,
        }),
      ).toBeUndefined();
    },
  );

  it("probes the CLI it found and shows its path", async () => {
    const path = install("homebrew/bin");
    const r = await probeEndpoint(
      { id: "claude-code", kind: "claude-code" },
      {
        clock,
        cliEnv: {
          PATH: LAUNCHD_PATH,
          HOME: join(dir, "home"),
          FAKE_CLI_AUTH: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
        },
        cliResolve: { knownDirs: [join(dir, "homebrew", "bin")], loginShell: false },
      },
    );
    expect(r).toMatchObject({
      state: "reachable",
      server: `Claude Code 2.1.286 · ${path} (claude.ai)`,
    });
  });

  it("says where it looked when the CLI is nowhere", async () => {
    const r = await probeEndpoint(
      { id: "claude-code", kind: "claude-code" },
      {
        clock,
        cliEnv: { PATH: LAUNCHD_PATH, HOME: join(dir, "home") },
        cliResolve: { knownDirs: [], loginShell: false },
      },
    );
    expect(r).toMatchObject({ state: "unreachable" });
    if (process.platform === "win32") {
      expect(r.error).toContain(`PSYCHE_CLAUDE_PATH, PATH, ${join("~", ".local", "bin")}`);
      expect(r.error).toContain(join("AppData", "Roaming", "npm"));
    } else {
      expect(r.error).toContain("PSYCHE_CLAUDE_PATH, PATH, /opt/homebrew/bin");
      expect(r.error).toContain("login shell");
    }
  });

  it("runs a turn through the CLI it found", async () => {
    install("homebrew/bin");
    const a = new CliAdapter(
      { id: "claude-code", kind: "claude-code", workdir: join(dir, "w") },
      claudeCodeDialect("claude-code"),
      {
        env: {
          PATH: LAUNCHD_PATH,
          HOME: join(dir, "home"),
          FAKE_CLI_SCRIPTS: JSON.stringify([
            resolve(import.meta.dirname, "fixtures/claude-code/text.json"),
          ]),
          FAKE_CLI_STATE: join(dir, "state"),
        },
        resolve: { knownDirs: [join(dir, "homebrew", "bin")], loginShell: false },
      },
    );
    try {
      const turn = await accumulate(
        a.stream({
          model: "claude-code/default",
          messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        }),
      );
      expect(turn.text()).toBe("Hello, world.");
    } finally {
      await a.close();
    }
  });
});
