import { describe, expect, it } from "vitest";
import { findSensitiveNormalized, type SensitiveKind } from "../src/index.ts";

// Assembled at runtime so the repo secret scans never match a tracked line (a Luhn-valid test PAN).
const j = (...parts: string[]) => parts.join("");
const PAN = j("4111", "1111", "1111", "1111");

const strictKinds = (text: string): SensitiveKind[] => [
  ...new Set(findSensitiveNormalized(text).map((m) => m.kind)),
];
const outboundKinds = (text: string): SensitiveKind[] => [
  ...new Set(findSensitiveNormalized(text, { outbound: true }).map((m) => m.kind)),
];

/** A 64-char sha256-shaped hex digest with a card-shaped run inside it. */
const SHA256_WITH_RUN = j("ab", PAN, "cd", "9f".repeat(22));

/** Inputs that are real card numbers: both readings must find a card in each. */
const MUST_REDACT: [string, string][] = [
  ["plain", PAN],
  ["spaces", j("4111", " ", "1111", " ", "1111", " ", "1111")],
  ["dashes", j("4111", "-", "1111", "-", "1111", "-", "1111")],
  ["label and trailing period", `card: ${PAN}.`],
  ["in parentheses", `(${PAN})`],
  ["inside a sentence", `please charge ${PAN} today`],
  ["after a colon", `number:${PAN}`],
];

/** Inputs whose digit run is part of a longer token: neither reading may call it a card. */
const MUST_NOT_REDACT: [string, string][] = [
  ["64-hex sha256 containing the run", SHA256_WITH_RUN],
  ["UUID", "3c4e7f2a-9b1d-4e8f-a6c2-5d7b0e9f1a34"],
  ["ULID", "01ARZ3NDEKTSV4RRFFQ69G5FAV"],
  ["git sha", "9fceb02d0ae598e95dc970b74767f19372d61af8"],
  ["run followed by a letter", `${PAN}abc`],
  ["run preceded by a letter", `abc${PAN}`],
];

describe("card detection respects token boundaries", () => {
  it.each(MUST_REDACT)("redacts a card (%s) in both readings", (_name, text) => {
    expect(strictKinds(text)).toContain("card_number");
    expect(outboundKinds(text)).toContain("card_number");
  });

  it.each(MUST_NOT_REDACT)("does not treat %s as a card in either reading", (_name, text) => {
    expect(strictKinds(text)).not.toContain("card_number");
    expect(outboundKinds(text)).not.toContain("card_number");
  });

  it("still finds a card that sits in a hex-looking sentence", () => {
    expect(strictKinds(`hash ${SHA256_WITH_RUN.slice(0, 20)} card ${PAN}`)).toContain(
      "card_number",
    );
  });

  it("keeps the other kinds working next to a hash", () => {
    const text = `token github_pat_${"a".repeat(22)} key ${SHA256_WITH_RUN}`;
    expect(strictKinds(text)).toContain("api_key");
    expect(strictKinds(text)).not.toContain("card_number");
  });
});
