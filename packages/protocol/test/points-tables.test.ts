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
  const file = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "points-tables.json",
  );
  const json = JSON.parse(readFileSync(file, "utf8")) as {
    words: { reason: string; source: string }[];
    benign: string[];
  };

  it("matches POINTS_SENSITIVE_WORDS", () => {
    expect(json.words).toEqual(POINTS_SENSITIVE_WORDS.map((w) => ({ reason: w.reason, source: w.source })));
  });

  it("matches POINTS_BENIGN_PHRASES", () => {
    expect(json.benign).toEqual([...POINTS_BENIGN_PHRASES]);
  });
});
