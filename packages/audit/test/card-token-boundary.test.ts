import { describe, expect, it } from "vitest";
import {
  findSensitive,
  findSensitiveNormalized,
  redactSensitive,
  type SensitiveKind,
} from "../src/index.ts";

// Assembled at runtime so the repo secret scans never match a tracked line (a Luhn-valid test PAN).
const j = (...parts: string[]) => parts.join("");
const PAN = j("4111", "1111", "1111", "1111");

/** Blocking readings: the default (strict) and the outbound one. No identifier-shape exception. */
const strictKinds = (text: string): SensitiveKind[] => [
  ...new Set(findSensitive(text).map((m) => m.kind)),
];
const outboundKinds = (text: string): SensitiveKind[] => [
  ...new Set(findSensitiveNormalized(text, { outbound: true }).map((m) => m.kind)),
];

/** A 64-char sha256-shaped hex digest with a card-shaped run inside it. */
const SHA256_WITH_RUN = j("ab", PAN, "cd", "9f".repeat(22));
/** A 40-char git sha with a card-shaped run inside it. */
const GIT_SHA_WITH_RUN = j("9f", PAN, "e5".repeat(11));
/** The padded form: a card with hex characters glued on, a 32-character hex-looking token. */
const PADDED = j(PAN, "abcdef0123456789");
/** An all-digit canonical UUID: every group is digits, so only the UUID shape identifies it. */
const DIGIT_UUID = "12345678-9012-3456-7890-123456789012";

/** Card numbers in plain and glued forms: every blocking reading must find each one. */
const MUST_BLOCK: [string, string][] = [
  ["plain", PAN],
  ["spaces", j("4111", " ", "1111", " ", "1111", " ", "1111")],
  ["dashes", j("4111", "-", "1111", "-", "1111", "-", "1111")],
  ["label and trailing period", `card: ${PAN}.`],
  ["in parentheses", `(${PAN})`],
  ["inside a sentence", `please charge ${PAN} today`],
  ["after a colon", `number:${PAN}`],
  ["letter glued after", `${PAN}a`],
  ["letter glued before", `x${PAN}`],
  ["word glued before", `card${PAN}`],
  ["letters glued after", `${PAN}abc`],
  ["padded with hex", PADDED],
  ["sha256 with an embedded run", SHA256_WITH_RUN],
  ["git sha with an embedded run", GIT_SHA_WITH_RUN],
];

/** Identifier-shaped tokens that redaction leaves readable for the owner's own logs. */
const REDACTION_SKIPS: [string, string][] = [
  ["64-hex sha256 containing the run", SHA256_WITH_RUN],
  ["40-hex git sha containing the run", GIT_SHA_WITH_RUN],
  ["canonical UUID", "3c4e7f2a-9b1d-4e8f-a6c2-5d7b0e9f1a34"],
  ["all-digit UUID", DIGIT_UUID],
  ["ULID", "01ARZ3NDEKTSV4RRFFQ69G5FAV"],
];

/** Glued-letter forms that redaction must still mask. */
const REDACTION_MASKS: [string, string][] = [
  ["letter glued after", `${PAN}a`],
  ["letter glued before", `x${PAN}`],
  ["word glued before", `card${PAN}`],
  ["letters glued after", `${PAN}abc`],
];

describe("blocking readings catch every card, including glued and padded ones", () => {
  it.each(MUST_BLOCK)("finds a card (%s) in the strict and outbound readings", (_name, text) => {
    expect(strictKinds(text)).toContain("card_number");
    expect(outboundKinds(text)).toContain("card_number");
  });

  it("finds the card in a sha256 through the explicit strict option", () => {
    expect(findSensitive(SHA256_WITH_RUN, { idTokens: "strict" }).map((m) => m.kind)).toContain(
      "card_number",
    );
  });
});

describe("redaction (idTokens: skip) leaves identifiers readable and masks cards", () => {
  it.each(REDACTION_SKIPS)("does not mask %s", (_name, text) => {
    expect(redactSensitive(text)).toBe(text);
    expect(findSensitive(text, { idTokens: "skip" }).map((m) => m.kind)).not.toContain(
      "card_number",
    );
  });

  it.each(REDACTION_MASKS)("masks a card (%s)", (_name, text) => {
    expect(redactSensitive(text)).toContain("[redacted:card_number]");
  });

  it("accepted residual: a card padded with hex is a 32-hex token, so the owner's log keeps it", () => {
    // Blocking paths catch this (see the prohibitions tests); only the owner's own log leaves it.
    expect(redactSensitive(PADDED)).toBe(PADDED);
  });

  it("masks a glued card in the middle of prose and keeps the rest", () => {
    expect(redactSensitive(`pay ${PAN}a now`)).toBe("pay [redacted:card_number]a now");
  });

  it("a caller that passes no options gets the strict reading (skills drafts)", () => {
    expect(redactSensitive(SHA256_WITH_RUN, {})).toContain("[redacted:card_number]");
  });
});
