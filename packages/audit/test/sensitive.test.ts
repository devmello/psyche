import { describe, expect, it } from "vitest";
import {
  cardDigits,
  containsSensitive,
  findSensitive,
  ibanValid,
  luhnValid,
  redactForAudit,
  redactSensitive,
} from "../src/index.ts";

// Secret-shaped strings are assembled at runtime so scripts/ci/secret-grep.sh never matches them.
const j = (...parts: string[]) => parts.join("");

describe("sensitive detectors", () => {
  it("validates Luhn and IBAN checksums", () => {
    expect(luhnValid("4242424242424242")).toBe(true);
    expect(luhnValid("4242424242424241")).toBe(false);
    expect(ibanValid("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(ibanValid("GB82 WEST 1234 5698 7654 33")).toBe(false);
  });

  it("finds Luhn-valid card numbers, grouped or not, and ignores other digit runs", () => {
    expect(cardDigits("4242 4242 4242 4242")).toBe("4242424242424242");
    expect(cardDigits("4111-1111-1111-1111")).toBe("4111111111111111");
    expect(containsSensitive("order 1234567890123 shipped")).toBe(false);
    expect(containsSensitive("0000000000000000")).toBe(false);
    expect(findSensitive("pay with 4242424242424242 now")[0]).toMatchObject({
      kind: "card_number",
      index: 9,
    });
  });

  it("does not flag sha256 references or ULIDs", () => {
    expect(containsSensitive(`sha256:${"ab12".repeat(16)}`)).toBe(false);
    expect(containsSensitive("01J9ZK4Q7W8X9Y0Z1A2B3C4D5E")).toBe(false);
  });

  it.each([
    ["anthropic key", j("sk-", "ant-", "x".repeat(30))],
    ["openai key", j("sk-", "proj-", "Ab3".repeat(12))],
    ["stripe live key", j("sk", "_live_", "a1".repeat(12))],
    ["github token", j("gh", "p_", "A".repeat(36))],
    ["aws key id", j("AK", "IA", "ABCDEFGHIJKLMNOP")],
    ["slack token", j("xo", "xb-", "1234567890-abc")],
    ["bearer", j("Bearer ", "a".repeat(24))],
    [
      "jwt",
      j("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJ", "zdWIiOiIxMjM0NTYifQ", ".", "c2lnbmF0dXJlLXZhbHVl"),
    ],
    ["pem", j("-----BEGIN ", "RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----")],
    ["url credentials", j("https:", "//user:hunter22", "@example.com/")],
    ["iban", "DE89370400440532013000"],
    ["ssn", "123-45-6789"],
  ])("flags %s", (_n, value) => {
    expect(containsSensitive(`before ${value} after`)).toBe(true);
    expect(redactSensitive(`before ${value} after`)).not.toContain(value);
  });
});

describe("redactForAudit", () => {
  it("drops secret keys, digests content keys, scrubs strings and stays JSON", () => {
    const out = redactForAudit({
      Authorization: "Basic abc",
      "api-key": "k",
      answer_token: "at_1",
      subject: "Re: invoice",
      html: "<p>hi</p>",
      params: { to: "a@b.c" },
      list: ["ok", j("gh", "p_", "B".repeat(36)), undefined],
      when: new Date(0),
      big: 10n,
      fn: () => 1,
      nan: Number.NaN,
    }) as Record<string, unknown>;
    expect(out).toMatchObject({
      Authorization: "[redacted]",
      "api-key": "[redacted]",
      answer_token: "[redacted]",
      subject: "Re: invoice",
      html: { redacted: "content" },
      params: { redacted: "content" },
      list: ["ok", "[redacted:api_key]", null],
      when: "1970-01-01T00:00:00.000Z",
      big: "10",
      nan: "NaN",
    });
    expect("fn" in out).toBe(false);
  });

  it("reduces very long strings to a digest", () => {
    const out = redactForAudit({ note: "x".repeat(5000) }, { maxStringLength: 100 });
    expect(out.note).toMatchObject({ redacted: "content", bytes: 5000 });
  });

  it("keeps configured keys verbatim", () => {
    const out = redactForAudit({ text: "visible" }, { keep: ["text"] });
    expect(out.text).toBe("visible");
  });
});
