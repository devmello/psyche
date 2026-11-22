#!/usr/bin/env node
/**
 * Release gate for psyche-server (docs/design/linux-helper-only-2026.md §7.2, wave B0): the
 * headless helper unit ships, and the Gateway's real starter starts it when no one is logged in.
 *
 * It loads the starter itself (`apps/gateway/src/compose/computer-linux.ts`, Node strips the
 * types) instead of grepping for the unit's name, and runs `startHelperWithSystemd` with a
 * recording runner and "no graphical session": the spawn must be
 * `systemctl --user start psyche-helper-headless.service`. It then checks that `composeComputer`
 * hands that starter to computer use. Exits 1 with the reason when any half is missing.
 *
 *   node deploy/scripts/check-headless-starter.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const UNIT_FILE = "deploy/systemd/psyche-helper-headless.service";
export const STARTER = "apps/gateway/src/compose/computer-linux.ts";
export const COMPOSE = "apps/gateway/src/compose/computer.ts";

/** @returns {Promise<{ ok: true, unit: string } | { ok: false, reason: string }>} */
export async function checkHeadlessStarter(repo = ROOT) {
  const unitFile = join(repo, UNIT_FILE);
  if (!existsSync(unitFile)) return { ok: false, reason: `${UNIT_FILE} is missing` };
  const unit = basename(unitFile);
  let mod;
  try {
    mod = await import(pathToFileURL(join(repo, STARTER)).href);
  } catch (err) {
    return { ok: false, reason: `${STARTER} does not load: ${err?.message ?? err}` };
  }
  const { helperUnitFor, startHelperWithSystemd } = mod;
  if (typeof helperUnitFor !== "function" || typeof startHelperWithSystemd !== "function") {
    return { ok: false, reason: `${STARTER} has no helperUnitFor or startHelperWithSystemd` };
  }
  if (helperUnitFor(false) !== unit) {
    return {
      ok: false,
      reason: `with no graphical session the Gateway picks ${helperUnitFor(false)}, not ${unit}`,
    };
  }
  const spawned = [];
  try {
    await startHelperWithSystemd(
      undefined,
      async (file, args) => {
        spawned.push([file, ...args]);
        return "";
      },
      async () => false,
    );
  } catch (err) {
    return { ok: false, reason: `the starter failed: ${err?.message ?? err}` };
  }
  const start = spawned.find((s) => s[1] === "--user" && s[2] === "start");
  if (start === undefined || !start[0].startsWith("/") || start[3] !== unit) {
    return {
      ok: false,
      reason: `the starter did not run systemctl --user start ${unit}: ${JSON.stringify(spawned)}`,
    };
  }
  let compose = "";
  try {
    compose = readFileSync(join(repo, COMPOSE), "utf8");
  } catch {
    return { ok: false, reason: `${COMPOSE} is missing` };
  }
  if (!/startHelper:\s*\([^)]*\)\s*=>\s*startHelperWithSystemd\(/.test(compose)) {
    return { ok: false, reason: `${COMPOSE} does not hand startHelperWithSystemd to computer use` };
  }
  return { ok: true, unit };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkHeadlessStarter();
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }
  process.stdout.write(`headless starter: ok (${result.unit})\n`);
}
