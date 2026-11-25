import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POINTS_BENIGN_PHRASES, POINTS_SENSITIVE_WORDS } from "../src/points-rules.ts";

/**
 * The Mac helper's judge uses tables generated from `points-rules.ts` (`PointsRuleTables.swift`,
 * made by `apps/mac-helper/scripts/gen-points-tables.mjs`, which also writes `points-tables.json`).
 * The Swift test `PointsRuleTablesFreshnessTests` compares the Swift tables to the same JSON, so a
 * rule changed here without regenerating fails one side or the other.
 */
describe("points rule tables shared with the Mac helper", () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "points-tables.json");
  const json = JSON.parse(readFileSync(file, "utf8")) as {
    words: { reason: string; source: string }[];
    benign: string[];
  };

  it("matches POINTS_SENSITIVE_WORDS", () => {
    expect(json.words).toEqual(
      POINTS_SENSITIVE_WORDS.map((w) => ({ reason: w.reason, source: w.source })),
    );
  });

  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const full = JSON.parse(readFileSync(file, "utf8")) as {
    confusables: Record<string, string>;
    venueDomains: string[];
  };

  it("matches the confusables table in points-rules.ts", () => {
    const src = readFileSync(join(dir, "points-rules.ts"), "utf8");
    const blocks: string[] = [];
    const first = src.match(/const CONFUSABLES[^=]*=\s*\{([\s\S]*?)\n\};/);
    if (first?.[1] !== undefined) blocks.push(first[1]);
    for (const m of src.matchAll(/Object\.assign\(CONFUSABLES, \{([\s\S]*?)\n\}\);/g))
      if (m[1] !== undefined) blocks.push(m[1]);
    const got: Record<string, string> = {};
    for (const body of blocks)
      for (const l of body.matchAll(/^\s*([^\s:/][^:]*?):\s*"([^"]*)",?\s*$/gm))
        got[(l[1] ?? "").trim()] = l[2] ?? "";
    expect(Object.keys(got).length).toBeGreaterThan(50);
    expect(full.confusables).toEqual(got);
  });

  it("matches HOST_VENUES in financial-block.ts", () => {
    const src = readFileSync(join(dir, "financial-block.ts"), "utf8");
    const body = src.match(/const HOST_VENUES[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? "";
    const hosts = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(hosts.length).toBeGreaterThan(100);
    expect(full.venueDomains).toEqual(hosts);
  });

  it("matches POINTS_BENIGN_PHRASES", () => {
    expect(json.benign).toEqual([...POINTS_BENIGN_PHRASES]);
  });
});
