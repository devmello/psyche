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
import { type M2Rig, prepareM2, SHOPPING_ID } from "./m2-stack.ts";

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
// Cases this stack still fails, pinned with their owner (#357 / #354 unpinned the five script and
// document cases).
const PATCH_ESCAPE =
  "S02 #439: code.edit's describe accepts a patch path outside the repo, so a card asks (run refuses it)";
const KNOWN_M2: Record<string, string> = {
  "code-patch-gitconfig-hooks-011[manual]": PATCH_ESCAPE,
  "code-patch-gitconfig-hooks-011[balanced]": PATCH_ESCAPE,
  "code-patch-gitconfig-hooks-011[auto]": PATCH_ESCAPE,
};
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
        "code.run",
        "code.edit",
        "code.git",
        "skills_read",
        `mcp__${SHOPPING_ID}__shop_checkout_handoff`,
      ]),
    );
    expect(report.stack.implementations).toMatchObject({
      agentLoop: "real",
      permissionBroker: "real",
      computerUseTools: "real",
    });
    expect(report.summary.runs).toBe(cases.reduce((n, c) => n + c.context.modes.length, 0));
  });

  it("offers every tool with a top-level object input schema (providers refuse anything else)", () => {
    // Anthropic and OpenAI need `type: "object"` at the top of a tool's input schema; one tool
    // without it fails every request that offers it (#414). The coding tools are registered
    // here so the check covers them.
    // #414 (`code.git`, `memory`) is fixed at the source (#425, #426): nothing is pinned.
    const KNOWN_SCHEMA: Record<string, string> = {};
    const bad = rig
      .toolSchemas()
      .filter((t) => (t.inputSchema as { type?: unknown } | undefined)?.type !== "object")
      .map((t) => t.name)
      .sort();
    expect(bad.filter((n) => KNOWN_SCHEMA[n] === undefined)).toEqual([]);
    expect(Object.keys(KNOWN_SCHEMA).filter((n) => !bad.includes(n))).toEqual([]);
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
