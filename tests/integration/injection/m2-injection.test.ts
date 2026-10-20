import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CorpusFile,
  type InjectionReport,
  loadCorpus,
  loadKnownFailures,
  runCorpus,
} from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type M2Rig, prepareM2 } from "./m2-stack.ts";

/**
 * #294: the injection corpus through the real agent loop, the real broker and the Gateway's real
 * computer-use, Apple Events, file, exec, MCP, browser and Google tool registrations (m2-stack.ts).
 * Writes `out/security/m2-injection-report.json` and the committed `m2-report.json` (no
 * timestamps, stable order: diffable).
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const CORPUS_DIR = "tests/corpus/injection/cases";
const EXAMPLE = "tests/integration/injection/example-cases.json";

const corpus = loadCorpus(join(root, CORPUS_DIR));
const example = JSON.parse(readFileSync(join(root, EXAMPLE), "utf8")) as CorpusFile;
const cases = [...corpus.cases, ...example.cases];
const files = [...corpus.files.map((f) => `${CORPUS_DIR}/${f}`), EXAMPLE];

/** Pins shared with every stack (`tests/corpus/injection/known-failures.json`). */
const SHARED = loadKnownFailures(join(root, CORPUS_DIR));
/**
 * `<id>[<mode>]` → why the real Gateway path fails this case today, with its issue and owner.
 * A pin that passes again must be removed.
 */
const KNOWN_M2: Record<string, string> = Object.fromEntries(
  [
    "app-script-terminal-target-026",
    "app-script-shell-025",
    "app-script-app-id-027",
    "ax-open-command-file-015",
    "file-name-bidi-004",
  ].flatMap((id) =>
    ["manual", "balanced", "auto"].map((mode) => [
      `${id}[${mode}]`,
      "S01 #354: the card comes first; the executor or helper refuses only after approval",
    ]),
  ),
);
const KNOWN = { ...SHARED, ...KNOWN_M2 };

let rig: M2Rig;
let report: InjectionReport;
const key = (r: { id: string; mode: string }) => `${r.id}[${r.mode}]`;

beforeAll(async () => {
  rig = await prepareM2(cases);
  report = await runCorpus(cases, { files, makeStack: rig.m2Stack, stackName: "m2" });
  const out = join(root, "out/security/m2-injection-report.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const committed = join(here, "m2-report.json");
  const same =
    existsSync(committed) &&
    JSON.stringify(JSON.parse(readFileSync(committed, "utf8"))) === JSON.stringify(report);
  if (!same) {
    writeFileSync(committed, `${JSON.stringify(report, null, 2)}\n`);
    try {
      execFileSync(join(root, "node_modules/.bin/biome"), ["format", "--write", committed], {
        stdio: "ignore",
      });
    } catch {
      // Cosmetic; `biome check` reports it.
    }
  }
}, 300_000);

afterAll(async () => {
  await rig?.close();
});

describe("injection corpus on the Milestone 2 stack (real loop, broker and Gateway tools)", () => {
  it("registers the real Gateway tool surfaces", () => {
    const names = rig.toolNames();
    expect(names).toEqual(
      expect.arrayContaining([
        "computer.act",
        "apps.open",
        "apps.applescript",
        "apps.shortcut_run",
        "read_file",
        "write_file",
        "exec",
        "browser.navigate",
        "mcp__notes-sync__upload",
      ]),
    );
    expect(report.stack.implementations).toMatchObject({
      agentLoop: "real",
      permissionBroker: "real",
      computerUseTools: "real",
    });
    expect(report.summary.runs).toBe(cases.reduce((n, c) => n + c.context.modes.length, 0));
  });

  it("has no error, and no fail beyond the pinned ones", () => {
    expect(report.results.filter((r) => r.status === "error").map(key)).toEqual([]);
    const bad = report.results
      .filter((r) => r.status === "fail" && KNOWN[key(r)] === undefined)
      .map((r) => `${key(r)}: ${r.actual}/${r.rule}: ${r.failures.join("; ")}`);
    expect(bad).toEqual([]);
    const stale = Object.keys(KNOWN_M2).filter(
      (k) => !report.results.some((r) => key(r) === k && r.status === "fail"),
    );
    expect(stale).toEqual([]);
  });
});
