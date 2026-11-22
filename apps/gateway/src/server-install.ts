import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Which psyche-server install this Gateway runs from (docs/design/linux-helper-only-2026.md §3.2,
 * wave B1), read from the release's `psyche-server.json` beside its bundle:
 * `<release>/psyched/runtime/node` is this process's own Node.
 */
const roots = new Map<string, string[]>();

/**
 * A psyche-server tarball install's root (deploy/linux-server/install.mjs: `releases/`, `current`,
 * `previous`), wherever its `--root` put it: the Gateway's own code, in a folder the owner's
 * account can write. Empty for every other install (the deb and rpm are root's, the desktop and a
 * checkout are not psyche-server).
 */
export function psycheServerTarballRoot(execPath: string = process.execPath): string[] {
  const known = roots.get(execPath);
  if (known !== undefined) return known;
  let found: string[] = [];
  try {
    const release = dirname(dirname(dirname(realpathSync(execPath))));
    const info = JSON.parse(readFileSync(join(release, "psyche-server.json"), "utf8")) as {
      format?: unknown;
      kind?: unknown;
      version?: unknown;
    };
    if (
      info.format === "psyche-server-install" &&
      info.kind === "tarball" &&
      typeof info.version === "string" &&
      basename(release) === info.version &&
      basename(dirname(release)) === "releases"
    )
      found = [dirname(dirname(release))];
  } catch {
    // Not a psyche-server release.
  }
  roots.set(execPath, found);
  return found;
}

/**
 * True when this Gateway is a psyche-server tarball install, whose helper is the account's own
 * file: the peer check cannot verify it (weak mode, as for the AppImage; an owner decision), and
 * Settings and `psyche status` say so.
 */
export function isTarballInstall(execPath: string = process.execPath): boolean {
  return psycheServerTarballRoot(execPath).length > 0;
}

const kinds = new Map<string, string | null>();

/**
 * The kind of psyche-server install this Gateway runs from (`deb`, `rpm` or `tarball`), read
 * from `psyche-server.json` beside its bundle (`<root>/psyched/runtime/node` is this process's
 * Node); null for every other install (the desktop app, a checkout, Docker).
 */
export function psycheServerKind(execPath: string = process.execPath): string | null {
  const known = kinds.get(execPath);
  if (known !== undefined) return known;
  let kind: string | null = null;
  try {
    const root = dirname(dirname(dirname(realpathSync(execPath))));
    const info = JSON.parse(readFileSync(join(root, "psyche-server.json"), "utf8")) as {
      format?: unknown;
      kind?: unknown;
    };
    if (
      info.format === "psyche-server-install" &&
      (info.kind === "deb" || info.kind === "rpm" || info.kind === "tarball")
    )
      kind = info.kind;
  } catch {
    // Not a psyche-server install.
  }
  kinds.set(execPath, kind);
  return kind;
}
