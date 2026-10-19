import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CorpusFile,
  type InjectionReport,
  loadCorpus,
  referenceStack,
  runCorpus,
} from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GOOGLE_ID, type Int2Rig, prepareInt2 } from "./stack.ts";

/**
 * INT-2 definition of done: S18's injection corpus runner executed against the real browser and
 * connector packages (stack.ts). Runs (a) the committed corpus and (b) the README's worked
 * example, copied verbatim into example-cases.json, with the INT-2 stack and with S18's reference
 * stack, and writes the INT-2 report to `out/security/int2-injection-report.json` and to
 * `report.json` next to this file (no timestamps, stable ordering: diffable).
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const CORPUS_DIR = "tests/corpus/injection/cases";
const EXAMPLE = "tests/integration/injection/example-cases.json";

const corpus = loadCorpus(join(root, CORPUS_DIR));
const example = JSON.parse(readFileSync(join(root, EXAMPLE), "utf8")) as CorpusFile;
const cases = [...corpus.cases, ...example.cases];
const files = [...corpus.files.map((f) => `${CORPUS_DIR}/${f}`), EXAMPLE];

/** `<id>[<mode>]` → why a fail / error is accepted for now. */
const KNOWN_FAILURES: Record<string, string> = {
  // The corpus expects `once,task` in every mode, but security §3.2 has manual-mode destructive
  // actions offer `once` only, which the broker does. Corpus fix requested from S18.
  "web-hidden-001[manual]":
    "corpus expects once,task in manual; security §3.2 manual destructive is once only",
};

/**
 * `<id>[<mode>]` → why the INT-2 and reference stacks reach a different outcome or rule. Each
 * entry is a finding for the owning session, not a test bug.
 */
const KNOWN_DIFFERENCES: Record<string, string> = Object.fromEntries(
  ["manual", "balanced", "auto"].map((mode) => [
    `web-hidden-001[${mode}]`,
    // Both stacks ask. The real broker names the deciding rule `taint:new_target` (the send's
    // recipient is new in a tainted turn, security §3.6); the reference broker names its mode
    // default. Issue #78 (connector sends denied kind:mismatch) is fixed.
    "S05: real broker asks with rule taint:new_target; reference asks with its mode default",
  ]),
);

let rig: Int2Rig;
let int2: InjectionReport;
let reference: InjectionReport;

const key = (r: { id: string; mode: string }) => `${r.id}[${r.mode}]`;
const write = (path: string, report: InjectionReport) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
};
/** The committed copy is rewritten only when its content changes, then put in Biome's format. */
const writeCommitted = (path: string, report: InjectionReport) => {
  const same =
    existsSync(path) &&
    JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) === JSON.stringify(report);
  if (same) return;
  write(path, report);
  try {
    execFileSync(join(root, "node_modules/.bin/biome"), ["format", "--write", path], {
      stdio: "ignore",
    });
  } catch {
    // Formatting is cosmetic; `biome check` reports it if this failed.
  }
};

beforeAll(async () => {
  rig = await prepareInt2(cases);
  int2 = await runCorpus(cases, { files, makeStack: rig.int2Stack, stackName: "int-2" });
  reference = await runCorpus(cases, { files, makeStack: referenceStack });
  write(join(root, "out/security/int2-injection-report.json"), int2);
  writeCommitted(join(here, "report.json"), int2);
}, 60_000);

afterAll(async () => {
  await rig?.close();
});

describe("injection corpus against the INT-2 stack", () => {
  it("runs on the real browser and connector registrations", () => {
    const names = rig.toolNames();
    expect(names).toEqual(expect.arrayContaining(["browser.navigate", "browser.fill_credential"]));
    expect(names).toEqual(expect.arrayContaining([`mcp__${GOOGLE_ID}__gmail_send`]));
    // The worked example's `gmail.send` is the Google connector's action, not a stand-in.
    expect(rig.route("gmail.send")).toBe(`mcp__${GOOGLE_ID}__gmail_send`);
    expect(int2.stack.name).toBe("int-2");
    expect(int2.stack.implementations).toMatchObject({
      permissionBroker: "real",
      browserTools: "real",
      connectorTools: "real",
    });
    expect(int2.corpus).toEqual({ files, cases: cases.length });
    expect(int2.summary.runs).toBe(cases.reduce((n, c) => n + c.context.modes.length, 0));
  });

  it("has no fail or error beyond the pinned known failures", () => {
    const bad = int2.results
      .filter((r) => r.status === "fail" || r.status === "error")
      .map((r) => `${key(r)} ${r.status}: ${r.failures.join("; ")}`);
    const unexpected = bad.filter((b) => KNOWN_FAILURES[b.split(" ")[0] ?? ""] === undefined);
    expect(unexpected).toEqual([]);
    // A pinned failure that now passes must be unpinned.
    const fixed = Object.keys(KNOWN_FAILURES).filter((k) => !bad.some((b) => b.startsWith(k)));
    expect(fixed).toEqual([]);
  });

  it("agrees with the reference stack, or the difference is pinned", () => {
    const ref = new Map(reference.results.map((r) => [key(r), r]));
    const diffs: string[] = [];
    for (const r of int2.results) {
      const o = ref.get(key(r));
      if (o === undefined) continue;
      if (o.actual !== r.actual || o.rule !== r.rule || o.status !== r.status) {
        diffs.push(
          `${key(r)} int-2 ${r.actual}/${r.rule}/${r.status} vs reference ${o.actual}/${o.rule}/${o.status}`,
        );
      }
    }
    expect(reference.summary.runs).toBe(int2.summary.runs);
    const unexpected = diffs.filter((d) => KNOWN_DIFFERENCES[d.split(" ")[0] ?? ""] === undefined);
    expect(unexpected).toEqual([]);
    const gone = Object.keys(KNOWN_DIFFERENCES).filter((k) => !diffs.some((d) => d.startsWith(k)));
    expect(gone).toEqual([]);
  });
});
