import { readFileSync } from "node:fs";
import type { ServerBuild } from "@psyche/protocol";
import pkg from "../package.json" with { type: "json" };

/**
 * Which build this Gateway process is (updates design §2.10), reported in the handshake's
 * `server` field so the desktop can tell an old Gateway left running across an app update from the
 * one it shipped with.
 *
 * Read once, when the process starts, never again: an update replaces the files under a running
 * Gateway, and a build read later would name the new files, not the code in memory.
 *
 * - `build` is the bundle's own `build-info.json` (named by `PSYCHE_BUILD_INFO`, which the
 *   bundled `psyched` launcher sets to the file beside it), read at start. Without one (a
 *   checkout, or a launcher that does not set it) it is the `PSYCHE_BUILD` the LaunchAgent plist
 *   carries, else `dev`.
 * - `envBuild` is that `PSYCHE_BUILD` claim, reported on its own when it is set: what the plist
 *   said, not what was verified from the bundle. The desktop compares `build`, and may use
 *   `envBuild` to tell a stale plist from a stale process.
 */
export function readServerBuild(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): ServerBuild {
  const version = pkg.version;
  const claimed = clean(env.PSYCHE_BUILD);
  let fileBuild: string | undefined;
  let commit: string | undefined;
  const infoPath = clean(env.PSYCHE_BUILD_INFO);
  if (infoPath !== undefined) {
    try {
      const info = JSON.parse(read(infoPath)) as { build?: unknown; commit?: unknown };
      fileBuild = typeof info.build === "string" ? clean(info.build) : undefined;
      commit = typeof info.commit === "string" ? clean(info.commit) : undefined;
    } catch {
      // No readable build info: the build falls back to the claim, else "dev".
    }
  }
  return {
    version,
    build: fileBuild ?? claimed ?? "dev",
    ...(commit === undefined ? {} : { commit }),
    ...(claimed === undefined || fileBuild === undefined ? {} : { envBuild: claimed }),
  };
}

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v === undefined || v === "" ? undefined : v.slice(0, 64);
}

let current: ServerBuild | undefined;

/** The build of this process, read on first use (which is at start-up, before any connection). */
export function serverBuild(): ServerBuild {
  current ??= readServerBuild();
  return current;
}
