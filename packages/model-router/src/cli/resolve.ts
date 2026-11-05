import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { envPath, windowsLaunchable } from "@psyche/hostfs";

export {
  envPath,
  type HostLaunch as CliLaunch,
  hostLaunch as cliLaunch,
  setEnvPath,
  shimTarget,
} from "@psyche/hostfs";

/**
 * Where a subscription CLI (`claude`, `codex`) lives (#530). The packaged Gateway runs under
 * launchd with a minimal PATH, so "on PATH" is not enough: an explicit path wins, then PATH, then
 * the places installers put these tools, and as a last resort the owner's login shell (a
 * Homebrew or nvm setup only `~/.zprofile` knows about).
 *
 * On Windows a GUI app inherits the owner's PATH, so there is no login-shell lookup; a bare name
 * is tried with `.exe`, `.cmd`, `.bat` and `.com`, and an npm `.cmd` shim is never run through
 * `cmd.exe` (the prompt is in argv): `cliLaunch` runs the shim's target instead.
 */

export type CliPathSource = "config" | "env" | "path" | "known_dir" | "login_shell";

export interface ResolvedCli {
  path: string;
  source: CliPathSource;
}

export interface ResolveCliOptions {
  /** `config.command`: a path, or a bare name to look up like the default. */
  command?: string;
  /** Environment to read `PSYCHE_<NAME>_PATH` and PATH from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Ask the login shell (default true; never on Windows). */
  loginShell?: boolean;
  /** Login-shell lookup budget (default 3 s). */
  timeoutMs?: number;
  /** Overrides the shell used for the last-resort lookup (tests). */
  shell?: string;
  /** Replaces the installers' directories (tests: a Homebrew-like temp directory). */
  knownDirs?: readonly string[];
}

const WIN = process.platform === "win32";
/** Windows: the extensions a bare name is tried with (never npm's extensionless sh shim). */
const WIN_EXTS = [".exe", ".cmd", ".bat", ".com"] as const;

/** nvm's per-version bins, newest first (`zsh -lc` does not read `.zshrc`, where nvm lives). */
function nvmDirs(home: string): string[] {
  const root = join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(root)
      .filter((v) => /^v\d+/.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => join(root, v, "bin"));
  } catch {
    return [];
  }
}

/**
 * Directories installers use, in order: Homebrew (Apple silicon, Intel), user bins, npm's global
 * prefix, Bun, Claude Code's own local install, then nvm. On Windows: Claude Code's native
 * installer (`~\.local\bin`), npm's global prefix (`%APPDATA%\npm`), Bun, Claude Code's local
 * install.
 */
export function knownCliDirs(home: string, env: NodeJS.ProcessEnv = {}): string[] {
  if (WIN) {
    return [
      join(home, ".local", "bin"),
      join(env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"),
      join(home, ".bun", "bin"),
      join(home, ".claude", "local"),
    ];
  }
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".claude", "local"),
    ...nvmDirs(home),
  ];
}

/** A regular file this user may execute (Windows: one `cliLaunch` can start). */
export function executable(path: string): boolean {
  if (WIN) return windowsLaunchable(path);
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `command` is a path, not a bare name to look up. */
export function isCommandPath(command: string): boolean {
  return isAbsolute(command) || command.includes("/") || (WIN && command.includes("\\"));
}

/** The file names a bare `name` may have on disk. */
function fileNames(name: string): readonly string[] {
  if (!WIN || extname(name) !== "") return [name];
  return WIN_EXTS.map((e) => `${name}${e}`);
}

function inDirs(name: string, dirs: readonly string[]): string | undefined {
  for (const d of dirs) {
    if (d.length === 0) continue;
    for (const n of fileNames(name)) {
      const p = join(d, n);
      if (executable(p)) return p;
    }
  }
  return undefined;
}

/** `command -v <name>` in the owner's login shell: only an absolute, executable path counts. */
function loginShellLookup(
  name: string,
  shell: string,
  timeoutMs: number,
): Promise<string | undefined> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-lc", `command -v ${name}`],
      { timeout: timeoutMs, maxBuffer: 64 * 1024, env: { HOME: homedir() } },
      (err, stdout) => {
        if (err !== null) return resolve(undefined);
        const line = String(stdout)
          .split("\n")
          .map((l) => l.trim())
          .reverse()
          .find((l) => isAbsolute(l));
        resolve(line !== undefined && executable(line) ? line : undefined);
      },
    );
  });
}

/** Finds `name` (`claude`, `codex`); undefined when it is nowhere. */
export async function resolveCli(
  name: string,
  options: ResolveCliOptions = {},
): Promise<ResolvedCli | undefined> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const explicit = options.command;
  if (explicit !== undefined && explicit !== name) {
    if (isCommandPath(explicit)) {
      return executable(explicit) ? { path: explicit, source: "config" } : undefined;
    }
  }
  const envPathVar = env[`PSYCHE_${name.toUpperCase()}_PATH`];
  if (envPathVar !== undefined && envPathVar.length > 0 && executable(envPathVar)) {
    return { path: envPathVar, source: "env" };
  }
  const bare = explicit !== undefined && !isCommandPath(explicit) ? explicit : name;
  const onPath = inDirs(bare, envPath(env).split(delimiter));
  if (onPath !== undefined) return { path: onPath, source: "path" };
  const known = inDirs(bare, options.knownDirs ?? knownCliDirs(home, env));
  if (known !== undefined) return { path: known, source: "known_dir" };
  // Windows has no login shell to ask: a GUI app already inherits the owner's PATH.
  if (options.loginShell === false || WIN) return undefined;
  const shell = options.shell ?? (executable("/bin/zsh") ? "/bin/zsh" : "/bin/sh");
  const viaShell = await loginShellLookup(bare, shell, options.timeoutMs ?? 3000);
  return viaShell === undefined ? undefined : { path: viaShell, source: "login_shell" };
}

/**
 * PATH for the CLI's own process: its directory first (an npm-installed `codex` is a
 * `#!/usr/bin/env node` script that needs the `node` next to it), then the known directories,
 * then what the Gateway has.
 */
export function cliChildPath(resolved: string, env: NodeJS.ProcessEnv, home: string): string {
  const parts = [
    dirname(resolved),
    ...knownCliDirs(home, env),
    ...envPath(env).split(delimiter),
    ...(WIN ? [] : ["/usr/bin", "/bin"]),
  ];
  return [...new Set(parts.filter((p) => p.length > 0))].join(delimiter);
}
