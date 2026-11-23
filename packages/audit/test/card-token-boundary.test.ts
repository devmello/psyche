import { describe, expect, it } from "vitest";
import { findSensitive, findSensitiveNormalized, type SensitiveKind } from "../src/index.ts";

// Assembled at runtime so the repo secret scans never match a tracked line (a Luhn-valid test PAN).
const j = (...parts: string[]) => parts.join("");
const PAN = j("4111", "1111", "1111", "1111");

/** The strict reading (audit redaction, hard prohibitions), read straight from findSensitive. */
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
/** An all-digit canonical UUID: every group is digits, so only the UUID shape identifies it. */
const DIGIT_UUID = "12345678-9012-3456-7890-123456789012";

/** Inputs that are card numbers: both readings must find a card in each. */
const MUST_REDACT: [string, string][] = [
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
];

/** Inputs whose digit run is part of an identifier: neither reading may call it a card. */
const MUST_NOT_REDACT: [string, string][] = [
  ["64-hex sha256 containing the run", SHA256_WITH_RUN],
  ["40-hex git sha containing the run", GIT_SHA_WITH_RUN],
  ["canonical UUID", "3c4e7f2a-9b1d-4e8f-a6c2-5d7b0e9f1a34"],
  ["all-digit UUID", DIGIT_UUID],
  ["ULID", "01ARZ3NDEKTSV4RRFFQ69G5FAV"],
];

describe("card detection: only identifier-shaped tokens are exempt", () => {
  it.each(MUST_REDACT)("redacts a card (%s) in both readings", (_name, text) => {
    expect(strictKinds(text)).toContain("card_number");
    expect(outboundKinds(text)).toContain("card_number");
  });

  it.each(MUST_NOT_REDACT)("does not treat %s as a card in either reading", (_name, text) => {
    expect(strictKinds(text)).not.toContain("card_number");
    expect(outboundKinds(text)).not.toContain("card_number");
  });

  it("still finds a card that sits next to a hash in the same text", () => {
    expect(strictKinds(`hash ${SHA256_WITH_RUN} card ${PAN}`)).toContain("card_number");
  });

  it("keeps the other kinds working next to a hash", () => {
    const text = `token github_pat_${"a".repeat(22)} key ${SHA256_WITH_RUN}`;
    expect(strictKinds(text)).toContain("api_key");
    expect(strictKinds(text)).not.toContain("card_number");
  });
});
