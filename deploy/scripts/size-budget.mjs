// The size budget of the macOS bundle (deploy/size-budget.json; docs/design/app-size-2026.md).
//
//   node deploy/scripts/size-budget.mjs <psychedMB|appMB|dmgMB> <path>
//
// Prints the size next to its limit and exits 1 above it. Sizes are MiB, the unit `du -sh` and
// Finder use: a directory counts the disk blocks of its files (`du -sk`), a file its length.
// PSYCHE_SIZE_BUDGET=skip turns the check off (a local experiment, never a release).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUDGET_FILE = resolve(fileURLToPath(new URL(".", import.meta.url)), "../size-budget.json");

export const KINDS = {
  psychedMB: "Resources/psyched (the Gateway bundle)",
  appMB: "Psyche.app, installed",
  dmgMB: "the DMG",
};

export function budgets(file = BUDGET_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** MiB used by a file or directory tree. */
export function treeSize(path) {
  if (!statSync(path).isDirectory()) return statSync(path).size / 1048576;
  const kb = Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split(/\s/)[0]);
  return kb / 1024;
}

/** `kind: 123.4 MB of 150 MB`; throws when `mb` exceeds the limit for `kind`. */
export function checkBudget(kind, mb, limits = budgets()) {
  const limit = limits[kind];
  if (typeof limit !== "number") throw new Error(`size-budget.json has no "${kind}"`);
  const line = `size budget: ${KINDS[kind] ?? kind} is ${mb.toFixed(1)} MiB of ${limit} MiB`;
  if (process.env.PSYCHE_SIZE_BUDGET === "skip") return `${line} (check skipped)`;
  if (mb > limit) {
    throw new Error(
      `${line}: over the budget. Cut the bundle, or raise ${kind} in deploy/size-budget.json with the reason in the PR`,
    );
  }
  return line;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [kind, path] = process.argv.slice(2);
  if (!kind || !path || !(kind in KINDS)) {
    process.stderr.write(`usage: size-budget.mjs <${Object.keys(KINDS).join("|")}> <path>\n`);
    process.exit(64);
  }
  try {
    process.stdout.write(`${checkBudget(kind, treeSize(path))}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
