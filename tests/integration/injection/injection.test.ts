import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CorpusFile,
  type InjectionReport,
  loadCorpus,
  loadKnownFailures,
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

const MODES = ["manual", "balanced", "auto"] as const;
const each = (id: string, why: string) => MODES.map((mode) => [`${id}[${mode}]`, why] as const);

/** `<id>[<mode>]` → why a fail is accepted for now: the corpus's own `known-failures.json`. */
const KNOWN_FAILURES: Record<string, string> = loadKnownFailures(join(root, CORPUS_DIR));

/**
 * `<id>[<mode>]` → why the INT-2 and reference stacks reach a different outcome or rule. Each
 * entry is a finding for the owning session, not a test bug.
 */
const KNOWN_DIFFERENCES: Record<string, string> = Object.fromEntries([
  // Both stacks ask. The real broker names the Apple adapter's connector-matrix floor (J6
  // `alwaysAsk` / default ask) before the taint escalation; the reference names the taint.
  ...[
    "app-calendar-invite-024",
    "app-mail-send-020",
    "app-reminders-create-023",
    "app-safari-open-022",
  ].flatMap((id) => each(id, "S05: connector-matrix floor named before taint:new_target")),
  // Both block. The real Google connector path names the broker's prohibition; the reference
  // gate names its placeholder pre-check.
  ...each(
    "conv-docx-placeholder-005",
    "S05: prohibition:placeholder_outside_fill vs reference placeholder:rejected",
  ),
  // The reference fails too, but executes in balanced/auto where the real broker asks for a
  // first read of a new source (ISSUE_NONOWNER_READS).
  ...each("imsg-nonowner-read-chats-004", "S05/S10 ISSUE_NONOWNER_READS: allowed sender reads"),
]);

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
