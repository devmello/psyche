import { type Dirent, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { defaultDenyRead } from "@psyche/mcp-host";
import type { FolderAccessEnv } from "@psyche/permissions";

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
  for (const p of defaultDenyRead(psycheHome)) {
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
