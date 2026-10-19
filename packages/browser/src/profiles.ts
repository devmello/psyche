import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";

/**
 * Agent browser profiles live under `$PSYCHE_HOME/browser/profiles/<name>/` (architecture §12;
 * data model §10 `browser_profiles`). Never the user's own Chrome profile.
 */

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function psycheHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PSYCHE_HOME ?? join(homedir(), ".psyche");
}

export function profilesDir(home = psycheHome()): string {
  return join(home, "browser", "profiles");
}

export function assertProfileName(name: string): void {
  if (!NAME.test(name)) {
    throw new PsycheError(
      "invalid_params",
      `profile name ${JSON.stringify(name)} must match ${NAME}`,
    );
  }
}

export async function profileDir(name: string, home = psycheHome()): Promise<string> {
  assertProfileName(name);
  const dir = join(profilesDir(home), name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function listProfileNames(home = psycheHome()): Promise<string[]> {
  const dir = profilesDir(home);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && NAME.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** A Chromium the Playwright driver can launch: env override, Playwright's own, or Chrome. */
export function findChromium(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [
    env.PSYCHE_CHROMIUM_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  return candidates.find((c) => c !== undefined && c !== "" && existsSync(c));
}
