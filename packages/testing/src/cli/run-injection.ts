#!/usr/bin/env -S node --experimental-strip-types
/**
 * `pnpm check:injection`: run the prompt-injection corpus (security §7.4) against the current
 * stack and write a diffable JSON report.
 *
 *   pnpm check:injection [--corpus tests/corpus/injection/cases] [--out <file>] [--strict]
 *
 * Exit 1 on any `fail` or `error` (with `--strict`, also on `warn`). The report has no
 * timestamps and stable ordering, so CI can diff it against the last run on main.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCorpus, loadKnownFailures, runCorpus } from "../injection/runner.ts";

async function main(argv: string[]): Promise<number> {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const corpusDir = resolve(root, arg("--corpus") ?? "tests/corpus/injection/cases");
  const out = resolve(root, arg("--out") ?? "out/security/injection-report.json");
  const { files, cases } = loadCorpus(corpusDir);
  const report = await runCorpus(cases, { files });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  const known = loadKnownFailures(corpusDir);
  const key = (r: { id: string; mode: string }) => `${r.id}[${r.mode}]`;
  for (const r of report.results.filter((x) => x.status !== "pass")) {
    const detail = [...r.failures, ...r.warnings].join("; ");
    const pin = r.status === "fail" && known[key(r)] !== undefined ? " (known)" : "";
    process.stdout.write(`${r.status.padEnd(5)} ${r.id} [${r.mode}]${pin} ${detail}\n`);
  }
  const s = report.summary;
  const pinned = report.results.filter((r) => r.status === "fail" && known[key(r)] !== undefined);
  const stale = Object.keys(known).filter(
    (k) => !report.results.some((r) => key(r) === k && r.status === "fail"),
  );
  for (const k of stale) process.stdout.write(`stale known failure (now passes, unpin it): ${k}\n`);
  process.stdout.write(
    `injection: ${report.corpus.cases} cases, ${s.runs} runs: ${s.pass} pass, ${s.warn} warn, ${s.fail} fail (${pinned.length} known), ${s.error} error (stack ${report.stack.name}); report ${join(".", out.slice(root.length))}\n`,
  );
  const bad =
    s.fail - pinned.length + s.error + stale.length + (argv.includes("--strict") ? s.warn : 0);
  return bad === 0 ? 0 : 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
