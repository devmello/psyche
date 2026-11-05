import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/**
 * Starting an owner-installed CLI (`claude`, `codex`, `bw`, `op`) without a shell.
 *
 * macOS and Linux run the file itself (its shebang decides). Windows cannot run a script, and since
 * Node's fix for CVE-2024-27980 `spawn` refuses `.cmd`/`.bat` files without `shell: true`, which
 * would hand the arguments to `cmd.exe` to re-parse. So on Windows an `.exe`/`.com` runs itself and a
 * Node script (`.js`, `.mjs`, `.cjs`, or the target of an npm/pnpm `.cmd` shim) runs with `node`.
 * Anything else cannot be started safely and gives undefined.
 */

const WIN_NATIVE = /\.(?:exe|com)$/i;
const WIN_SHIM = /\.(?:cmd|bat)$/i;
const NODE_SCRIPT = /\.[cm]?js$/i;

/** The PATH of `env` (on Windows the key is case-insensitive and often spelled `Path`). */
export function envPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return env.PATH ?? "";
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  return key === undefined ? "" : (env[key] ?? "");
}

/** Sets PATH on `env`, dropping the key's other spellings (Windows). */
export function setEnvPath(
  env: NodeJS.ProcessEnv,
  value: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32")
    for (const k of Object.keys(env)) if (k.toUpperCase() === "PATH") delete env[k];
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
export interface HostLaunch {
  command: string;
  args: string[];
  /** Added to the child's environment. */
  env?: Record<string, string>;
}

/** `node.exe` on the child's PATH (like `#!/usr/bin/env node`), else the Gateway's runtime. */
function nodeLaunch(script: string, env: NodeJS.ProcessEnv): HostLaunch {
  for (const d of envPath(env, "win32").split(delimiter)) {
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
 * or an npm `.cmd` shim's target) with `node`, never through `cmd.exe`; undefined when `path`
 * cannot be run that way.
 */
export function hostLaunch(
  path: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): HostLaunch | undefined {
  if (platform !== "win32" || WIN_NATIVE.test(path)) return { command: path, args: [] };
  if (NODE_SCRIPT.test(path)) return nodeLaunch(path, env);
  const target = WIN_SHIM.test(path) ? shimTarget(path) : undefined;
  if (target === undefined || !isFile(target)) return undefined;
  return WIN_NATIVE.test(target) ? { command: target, args: [] } : nodeLaunch(target, env);
}

/** Whether `hostLaunch` can start the file at `path` (Windows; POSIX callers check X_OK). */
export function windowsLaunchable(path: string): boolean {
  if (!isFile(path)) return false;
  if (WIN_NATIVE.test(path) || NODE_SCRIPT.test(path)) return true;
  const target = WIN_SHIM.test(path) ? shimTarget(path) : undefined;
  return target !== undefined && isFile(target);
}
