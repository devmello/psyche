import { type Dirent, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultDenyRead } from "@psyche/mcp-host";
import { CLI_HOME_DIRS } from "@psyche/model-router";
import { type FolderAccessEnv, linuxRunCarveOuts, persistenceRoots } from "@psyche/permissions";
import { DESKTOP_APP_NAME } from "./desktop-launch.ts";

/**
 * Linux: the config, data and cache folders, where a written file runs code as the owner later
 * (desktop entries, autostart, user services, D-Bus activation, Flatpak overrides, Python `.pth`
 * files, app plug-ins and start-up scripts, shell extensions, the terminal lists and caches).
 * Write-protected wholesale, as `~/Library`'s persistence folders are on macOS; reads follow the
 * grants (review of #1294, rounds 3 to 5). The shell and session start-up files are in
 * `PERSISTENCE_HOME_PATHS`.
 */
export const LINUX_EXEC_PATHS: readonly (readonly string[])[] = [
  [".config"],
  [".local"],
  [".cache"],
];

/**
 * Every platform: what git runs on its own (`core.hooksPath`, `core.fsmonitor`, aliases) and
 * `~/bin`, which shells put on PATH. Write-protected; `persistenceRoots` names them on macOS and
 * Linux, and this adds them on Windows.
 */
export const RUNS_CODE_PATHS: readonly (readonly string[])[] = [
  ["bin"],
  [".gitconfig"],
  [".config", "git"],
];

/**
 * Linux: the runtime and kernel file systems: `/run/user/<uid>` holds D-Bus services, user units
 * and the agents' sockets, `/proc` every process's environment. Neither read nor written, apart
 * from the owner's drives and network mounts (`linuxRunCarveOuts`, through `ownWorkdirs`).
 */
export const LINUX_SYSTEM_ROOTS: readonly string[] = ["/run", "/proc", "/sys"];

/**
 * Paths no file tool or Files-pane method reads or writes, whatever folder the owner granted
 * (security §5.3, #285): all of `$PSYCHE_HOME` (vault slots, state, audit, browser profiles,
 * the workspace files only the memory tool may change), `~/.ssh` and the other credential stores
 * MCP servers are denied too. The Library is reached through `libraryPath` / `library.*`,
 * never as a granted path. Each entry is given as written and as its real path, since granted
 * paths are compared as real paths.
 */
export function protectedRoots(
  psycheHome: string,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
): string[] {
  const out = new Set<string>();
  // The CLI binaries Psyche runs unsandboxed (`~/.local/share/claude`, `~/.bun`...): not writable
  // through a wide grant such as an older home-root one. Not in `defaultDenyRead`: MCP servers
  // run `npx` from `~/.npm-global`.
  const cliDirs = CLI_HOME_DIRS.map((segments) => join(userHome, ...segments));
  const linux = platform === "linux" ? LINUX_SYSTEM_ROOTS : [];
  for (const p of [...defaultDenyRead(psycheHome), ...cliDirs, ...linux]) {
    out.add(p);
    try {
      out.add(realpathSync(p));
    } catch {
      // Not there (yet): the written path is enough.
    }
  }
  return [...out];
}

/**
 * Paths no agent write reaches, whatever folder is granted (an older home-root share included),
 * on top of `protectedRoots`: the persistence locations under the owner's home (`~/Applications`,
 * LaunchAgents, Preferences, shell rc files, `.gitconfig`...) and Psyche.app wherever it is
 * installed. Reads there follow the grants as before. Each entry as written and as its real path.
 */
export function writeProtectedRoots(
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const out = new Set<string>();
  const home = (segments: readonly string[]) => join(userHome, ...segments);
  for (const p of [
    ...persistenceRoots(userHome),
    ...RUNS_CODE_PATHS.map(home),
    ...(platform === "linux" ? LINUX_EXEC_PATHS.map(home) : []),
    `/Applications/${DESKTOP_APP_NAME}.app`,
    join(userHome, "Applications", `${DESKTOP_APP_NAME}.app`),
  ]) {
    out.add(p);
    try {
      out.add(realpathSync(p));
    } catch {
      // Not there (yet): the written path is enough.
    }
  }
  return [...out];
}

/**
 * The working directories Psyche gives the subscription CLI providers (`<home>/cli/<id>`, see
 * `resolveRouter`), as written and as real paths. They are the one place inside `$PSYCHE_HOME`
 * a granted folder may reach: the models in those CLIs run with it as their cwd, so asking the
 * owner to share it is asking for what Psyche made for them. Only real, direct sub-folders of
 * `<home>/cli` count (a link is never followed out of it), and nothing else under the home does.
 */
export function ownWorkdirs(
  psycheHome: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const root = join(psycheHome, "cli");
  const out = new Set<string>();
  // Linux: the owner's drives and network mounts are the places under `/run` a file tool reaches.
  if (platform === "linux") for (const dir of linuxRunCarveOuts()) out.add(dir);
  let names: Dirent[];
  try {
    names = readdirSync(root, { withFileTypes: true });
  } catch {
    return [...out];
  }
  for (const e of names) {
    if (!e.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(e.name)) continue;
    const dir = join(root, e.name);
    out.add(dir);
    try {
      out.add(realpathSync(dir));
    } catch {
      // Gone since the listing.
    }
  }
  return [...out];
}

/** What the folder-share checks (the card, the broker, Settings) judge a folder by. */
export function folderAccessEnv(psycheHome: string): FolderAccessEnv {
  return {
    psycheHome,
    protectedRoots: protectedRoots(psycheHome),
    ownDirs: ownWorkdirs(psycheHome),
  };
}
