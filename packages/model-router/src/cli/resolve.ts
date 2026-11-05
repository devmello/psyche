import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";

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
const WIN_NATIVE = /\.(?:exe|com)$/i;
const WIN_SHIM = /\.(?:cmd|bat)$/i;
const NODE_SCRIPT = /\.[cm]?js$/i;

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

/** The PATH of `env` (on Windows the key is case-insensitive and often spelled `Path`). */
export function envPath(env: NodeJS.ProcessEnv): string {
  if (!WIN) return env.PATH ?? "";
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  return key === undefined ? "" : (env[key] ?? "");
}

/** Sets PATH on `env`, dropping the key's other spellings (Windows). */
export function setEnvPath(env: NodeJS.ProcessEnv, value: string): void {
  if (WIN) for (const k of Object.keys(env)) if (k.toUpperCase() === "PATH") delete env[k];
  env.PATH = value;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * What an npm (`cmd-shim`) or pnpm `.cmd` shim runs: the last quoted path before `%*`, relative
 * to the shim's directory (`%dp0%`, `%~dp0`) or absolute. An `.exe` is returned as is; a script
 * only when the shim runs it with `node`. Anything else is undefined.
 */
export function shimTarget(shim: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return undefined;
  }
  let target: string | undefined;
  for (const m of text.matchAll(/"([^"]+)"\s*%\*/g)) target = m[1];
  if (target === undefined) return undefined;
  const path = target.replace(/^(?:%dp0%|%~dp0)\\?/i, `${dirname(shim)}\\`);
  if (path.includes("%") || !isAbsolute(path) || /node\.exe$/i.test(path)) return undefined;
  if (WIN_NATIVE.test(path)) return path;
  // `cmd-shim`'s `"%_prog%"` is `%dp0%\node.exe` or `node`; another program is not supported.
  const viaNode = /\bnode(?:\.exe)?\b/i.test(text) && !/_prog=(?!node|%dp0%\\node)/i.test(text);
  return viaNode ? path : undefined;
}

/** How to start a resolved CLI: the program to spawn and the arguments before the CLI's own. */
export interface CliLaunch {
  command: string;
  args: string[];
  /** Added to the child's environment. */
  env?: Record<string, string>;
}

/** `node.exe` on the child's PATH (like `#!/usr/bin/env node`), else the Gateway's runtime. */
function nodeLaunch(script: string, env: NodeJS.ProcessEnv): CliLaunch {
  for (const d of envPath(env).split(delimiter)) {
    if (d.length === 0 || !isAbsolute(d)) continue;
    const node = join(d, "node.exe");
    if (isFile(node)) return { command: node, args: [script] };
  }
  // Electron runs a script only with ELECTRON_RUN_AS_NODE.
  return { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/**
 * How to run the CLI at `path` with the child environment `env` (whose PATH picks `node`). POSIX
 * runs the file itself. Windows runs an `.exe` itself and a Node script (`.js`, `.mjs`, `.cjs`,
 * or an npm `.cmd` shim's target) with `node`, never through `cmd.exe`, which would re-parse
 * the arguments; undefined when `path` cannot be run that way.
 */
export function cliLaunch(path: string, env: NodeJS.ProcessEnv): CliLaunch | undefined {
  if (!WIN || WIN_NATIVE.test(path)) return { command: path, args: [] };
  if (NODE_SCRIPT.test(path)) return nodeLaunch(path, env);
  const target = WIN_SHIM.test(path) ? shimTarget(path) : undefined;
  if (target === undefined || !isFile(target)) return undefined;
  return WIN_NATIVE.test(target) ? { command: target, args: [] } : nodeLaunch(target, env);
}

/** A regular file this user may execute (Windows: one `cliLaunch` can start). */
export function executable(path: string): boolean {
  if (WIN) {
    if (!isFile(path)) return false;
    if (WIN_NATIVE.test(path) || NODE_SCRIPT.test(path)) return true;
    const target = WIN_SHIM.test(path) ? shimTarget(path) : undefined;
    return target !== undefined && isFile(target);
  }
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
