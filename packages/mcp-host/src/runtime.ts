import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { PsycheError } from "@psyche/protocol";

/**
 * Which program a stdio server's first word means, and where it really is. A LaunchAgent starts
 * the Gateway with a bare PATH and the app ships `runtime/node` without npm, so a preset's `npx`
 * or `uvx` was never found (`spawn ENOENT` inside srt: "The server did not start"). Node-based
 * servers now run on Psyche's own Node (the `npx` script found on this Mac, started by it), and
 * `uvx` is looked up in the usual install folders and by absolute path.
 */

export type RuntimeKind = "node" | "uv";

/** Stable phrases; `diagnoseLaunch` recognises them. */
export const RUNTIME_MISSING_TEXT: Record<RuntimeKind, string> = {
  node: "Node.js tools (npm) are needed to run this server but were not found on this Mac",
  uv: "uv (uvx) is needed to run this Python server but was not found on this Mac",
};

export interface RuntimeDeps {
  /** Psyche's bundled Node: runs Node-based servers instead of a system `node`. */
  nodePath: string;
  /** Folders to look in, in order (PATH, Homebrew, ~/.local/bin, ...). */
  searchDirs(): readonly string[];
  isFile(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
}

export function systemRuntimeDeps(
  nodePath: string,
  searchDirs: () => readonly string[],
): RuntimeDeps {
  return {
    nodePath,
    searchDirs,
    async isFile(path) {
      try {
        await access(path, constants.R_OK);
        return true;
      } catch {
        return false;
      }
    },
    realpath,
  };
}

export interface ResolvedRuntimeCommand {
  command: string[];
  /** Overrides for the spawned environment (PATH, caches inside the scratch folder). */
  env: Record<string, string>;
  runtime: RuntimeKind | null;
}

const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function missing(kind: RuntimeKind): PsycheError {
  return new PsycheError("unavailable", RUNTIME_MISSING_TEXT[kind], {
    details: { reason: "runtime_missing", runtime: kind },
  });
}

async function findNpxCli(deps: RuntimeDeps): Promise<string | undefined> {
  for (const dir of deps.searchDirs()) {
    if (dir === "" || !isAbsolute(dir)) continue;
    // `npx` is a symlink to npm's `bin/npx-cli.js` in every standard install.
    const bin = join(dir, "npx");
    if (await deps.isFile(bin)) {
      try {
        const real = await deps.realpath(bin);
        if (real.endsWith(".js")) return real;
      } catch {
        // fall through to the lib layout
      }
    }
    for (const lib of [
      join(dir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
      join(dir, "node_modules", "npm", "bin", "npx-cli.js"),
    ]) {
      if (await deps.isFile(lib)) return lib;
    }
  }
  return undefined;
}

async function findExecutable(name: string, deps: RuntimeDeps): Promise<string | undefined> {
  for (const dir of deps.searchDirs()) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (await deps.isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The argv and environment overrides to launch a server's command. Caches and logs go to the
 * scratch folder because the sandbox lets a server write nowhere else.
 */
export async function resolveRuntimeCommand(
  command: readonly string[],
  deps: RuntimeDeps,
  scratch: string,
): Promise<ResolvedRuntimeCommand> {
  const [first, ...rest] = command;
  if (first === undefined || first.includes("/")) {
    return { command: [...command], env: {}, runtime: null };
  }
  const nodeDir = dirname(deps.nodePath);
  const cacheEnv = {
    XDG_CACHE_HOME: join(scratch, "cache"),
    npm_config_cache: join(scratch, "npm-cache"),
    npm_config_logs_dir: join(scratch, "npm-logs"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    UV_CACHE_DIR: join(scratch, "uv-cache"),
    UV_TOOL_DIR: join(scratch, "uv-tools"),
    UV_NO_PROGRESS: "1",
  };
  if (first === "node") {
    return {
      command: [deps.nodePath, ...rest],
      env: { PATH: [nodeDir, ...SYSTEM_PATH].join(delimiter), ...cacheEnv },
      runtime: "node",
    };
  }
  if (first === "npx") {
    const cli = await findNpxCli(deps);
    if (cli === undefined) throw missing("node");
    return {
      command: [deps.nodePath, cli, ...rest],
      env: { PATH: [nodeDir, dirname(cli), ...SYSTEM_PATH].join(delimiter), ...cacheEnv },
      runtime: "node",
    };
  }
  if (first === "uvx" || first === "uv") {
    const exe = await findExecutable(first, deps);
    if (exe === undefined) throw missing("uv");
    return {
      command: [exe, ...rest],
      env: { PATH: [dirname(exe), nodeDir, ...SYSTEM_PATH].join(delimiter), ...cacheEnv },
      runtime: "uv",
    };
  }
  return { command: [...command], env: {}, runtime: null };
}
