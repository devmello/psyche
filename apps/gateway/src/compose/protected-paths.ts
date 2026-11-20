import { type Dirent, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type GrantedFolder, homeShareGoverns, type WriteProtection } from "@psyche/files";
import { defaultDenyRead } from "@psyche/mcp-host";
import { CLI_HOME_DIRS } from "@psyche/model-router";
import { type FolderAccessEnv, writeProtectedHomeRoots } from "@psyche/permissions";
import { DESKTOP_APP_NAME } from "./desktop-launch.ts";

/**
 * Paths no file tool or Files-pane method reads or writes, whatever folder the owner granted
 * (security §5.3, #285): all of `$PSYCHE_HOME` (vault slots, state, audit, browser profiles,
 * the workspace files only the memory tool may change), `~/.ssh` and the other credential stores
 * MCP servers are denied too. The Library is reached through `libraryPath` / `library.*`,
 * never as a granted path. Each entry is given as written and as its real path, since granted
 * paths are compared as real paths.
 */
export function protectedRoots(psycheHome: string): string[] {
  const out = new Set<string>();
  // The CLI binaries Psyche runs unsandboxed (`~/.local/share/claude`, `~/.bun`...): not writable
  // through a wide grant such as an older home-root one. Not in `defaultDenyRead`: MCP servers
  // run `npx` from `~/.npm-global`.
  const cliDirs = CLI_HOME_DIRS.map((segments) => join(homedir(), ...segments));
  for (const p of [...defaultDenyRead(psycheHome), ...cliDirs]) {
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
export function writeProtectedRoots(userHome: string = homedir()): string[] {
  const out = new Set<string>();
  for (const p of [
    ...writeProtectedHomeRoots(userHome),
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
 * `writeProtectedRoots` plus the owner's home for the dot-entry rule: under a share of the whole
 * home folder, no agent write reaches `~/.anything` (#1427 review r1, finding 5).
 */
export function writeProtection(userHome: string = homedir()): WriteProtection {
  return { roots: writeProtectedRoots(userHome), dotHome: userHome };
}

/**
 * The same, for one write: the dot-entry rule only when the longest granted folder holding
 * `path` is the home folder or one around it (`homeShareGoverns`).
 */
export function writeProtectionFor(
  path: string,
  folders: readonly GrantedFolder[] | undefined,
  userHome: string = homedir(),
): WriteProtection {
  const w = writeProtection(userHome);
  return homeShareGoverns(path, userHome, folders) ? w : { roots: w.roots };
}

/**
 * The working directories Psyche gives the subscription CLI providers (`<home>/cli/<id>`, see
 * `resolveRouter`), as written and as real paths. They are the one place inside `$PSYCHE_HOME`
 * a granted folder may reach: the models in those CLIs run with it as their cwd, so asking the
 * owner to share it is asking for what Psyche made for them. Only real, direct sub-folders of
 * `<home>/cli` count (a link is never followed out of it), and nothing else under the home does.
 */
export function ownWorkdirs(psycheHome: string): string[] {
  const root = join(psycheHome, "cli");
  const out = new Set<string>();
  let names: Dirent[];
  try {
    names = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
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
