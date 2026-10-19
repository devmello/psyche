import { describe, expect, it } from "vitest";
import {
  findPatterns,
  loadSecretRegistry,
  luhnValid,
  type PatternKind,
  resolveSample,
} from "../src/index.ts";

const registry = loadSecretRegistry();
const KINDS: PatternKind[] = [
  "card",
  "us_ssn",
  "iban",
  "us_bank_account",
  "passport",
  "private_key_block",
];

describe("pattern detectors (registry patternSamples)", () => {
  for (const kind of KINDS) {
    const samples = registry.patternSamples[kind];
    it(`${kind}: catches every mustMatch sample`, () => {
      expect(samples?.mustMatch?.length).toBeGreaterThan(0);
      for (const s of samples?.mustMatch ?? []) {
        const text = `before ${resolveSample(s)} after`;
        expect(
          findPatterns(text).map((m) => m.kind),
          `sample #${samples?.mustMatch?.indexOf(s)}`,
        ).toContain(kind);
      }
    });
    it(`${kind}: ignores every mustNotMatch sample`, () => {
      for (const s of samples?.mustNotMatch ?? []) {
        const text = `before ${resolveSample(s)} after`;
        expect(findPatterns(text).map((m) => m.kind)).not.toContain(kind);
      }
    });
  }

  it("never flags valid placeholders", () => {
    for (const s of registry.patternSamples.placeholder_ok?.mustNotMatch ?? []) {
      expect(findPatterns(resolveSample(s))).toEqual([]);
    }
  });

  it("does not read the fraction of a float as a card", () => {
    expect(findPatterns('{"domSnapshotMs": 61.4057499999999}')).toEqual([]);
  });

  it("does not read mixed-separator digit runs as a card", () => {
    expect(findPatterns("4242-4242 4242 4242").map((m) => m.kind)).not.toContain("card");
  });

  it("reports offsets of the match", () => {
    const card = resolveSample(registry.patternSamples.card?.mustMatch?.[0] ?? "");
    const [hit] = findPatterns(`xx ${card}`);
    expect(hit).toMatchObject({ kind: "card", offset: 3, length: card.length });
  });

  it("honours per-call allow lists", () => {
    const card = resolveSample(registry.patternSamples.card?.mustMatch?.[0] ?? "");
    expect(findPatterns(card, ["card"])).toEqual([]);
  });

  it("luhnValid", () => {
    expect(luhnValid("79927398713")).toBe(true);
    expect(luhnValid("79927398710")).toBe(false);
    expect(luhnValid("")).toBe(false);
  });
});
