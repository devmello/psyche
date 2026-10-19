#!/usr/bin/env -S node --experimental-strip-types
/**
 * Scripted acceptance scenarios (tests/scenarios, INT-3): run V1, V2 and V7 against the real
 * agent loop and Permission Broker and print the failures.
 *
 *   tsx packages/testing/src/scenarios/cli.ts [--dir tests/scenarios] [--out report.json] [--all]
 *
 * Exit 1 on any hard failure not listed in `tests/scenarios/known-failures.json` (each entry names
 * its issue), and on any listed entry that no longer fails (stale). `--all` also prints passing
 * assertions. The JSON report has no timestamps and stable ordering.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runAllScenarios, SCENARIOS_DIR } from "./runner.ts";

async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = arg("--dir");
  const root = dir === undefined ? SCENARIOS_DIR : resolve(dir);
  const report = await runAllScenarios(root);
  const knownPath = join(root, "known-failures.json");
  const known: Record<string, Record<string, string>> = existsSync(knownPath)
    ? JSON.parse(readFileSync(knownPath, "utf8"))
    : {};
  let unexpected = 0;
  const out = arg("--out");
  if (out !== undefined) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  }
  for (const s of report.scenarios) {
    const h = s.summary.hard;
    const soft = s.summary.soft;
    process.stdout.write(
      `${s.ok ? "ok  " : "FAIL"} ${s.scenario}: hard ${h.pass} pass / ${h.fail} fail / ${h.unchecked} unchecked; soft ${soft.pass} / ${soft.fail} / ${soft.unchecked}\n`,
    );
    const knownHere = known[s.scenario] ?? {};
    for (const a of s.assertions) {
      const issue = knownHere[a.id];
      const hardFail = a.severity === "hard" && a.status === "fail";
      if (hardFail && issue === undefined) unexpected += 1;
      if (a.status === "pass" && !argv.includes("--all")) continue;
      const tag = hardFail && issue !== undefined ? ` (known: ${issue})` : "";
      process.stdout.write(
        `  ${a.status.padEnd(9)} ${a.severity} ${a.id} [${a.type}] ${a.detail}${tag}\n`,
      );
    }
    for (const id of Object.keys(knownHere)) {
      const a = s.assertions.find((x) => x.id === id);
      if (a?.status !== "fail") {
        unexpected += 1;
        process.stdout.write(`  stale     known failure ${id} no longer fails; remove it\n`);
      }
    }
  }
  return unexpected === 0 ? 0 : 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
