import { readFileSync } from "node:fs";
import type { ServerBuild } from "@psyche/protocol";
import pkg from "../package.json" with { type: "json" };

/**
 * Which build this Gateway process is (updates design §2.10), reported in the handshake's
 * `server` field so the desktop can tell an old Gateway left running across an app update from the
 * one it shipped with.
 *
 * Read once, when the process starts, never again: an update replaces the files under a running
 * Gateway, and a build read later would name the new files, not the code in memory. Sources, first
 * match wins:
 * 1. `PSYCHE_BUILD`, which the desktop writes into the LaunchAgent plist;
 * 2. `build-info.json` named by `PSYCHE_BUILD_INFO` (the bundled `psyched` launcher points it at
 *    the file beside it);
 * 3. `dev`, when running from a checkout.
 */
export function readServerBuild(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): ServerBuild {
  const version = pkg.version;
  let build = clean(env.PSYCHE_BUILD);
  let commit: string | undefined;
  const infoPath = clean(env.PSYCHE_BUILD_INFO);
  if (infoPath !== undefined) {
    try {
      const info = JSON.parse(read(infoPath)) as { build?: unknown; commit?: unknown };
      build ??= typeof info.build === "string" ? clean(info.build) : undefined;
      commit = typeof info.commit === "string" ? clean(info.commit) : undefined;
    } catch {
      // No readable build info: the build stays whatever the environment said, else "dev".
    }
  }
  return { version, build: build ?? "dev", ...(commit === undefined ? {} : { commit }) };
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
