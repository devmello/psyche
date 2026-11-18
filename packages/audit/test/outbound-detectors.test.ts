import { fixtureSecret } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { findSensitiveNormalized, type SensitiveKind } from "../src/index.ts";

// Assembled at runtime so the repo secret scans never match a tracked line.
const j = (...parts: string[]) => parts.join("");
const CARD = fixtureSecret("link-virtual-card").replace(/\D/g, "");
const kinds = (text: string): SensitiveKind[] => [
  ...new Set(findSensitiveNormalized(text).map((m) => m.kind)),
];

/** Inputs that must be found, and the kind each must produce. */
const MUST_CATCH: [string, string, SensitiveKind][] = [
  [
    "routing and account",
    `Routing number: ${j("0210", "00021")}, account number ${j("12345", "67890")}`,
    "us_bank_account",
  ],
  ["ABA then acct", `ABA ${j("0210", "00021")} / acct ${j("9876", "543210")}`, "us_bank_account"],
  ["cvv beside a card", `${CARD} cvv 123`, "card_security"],
  ["expiry beside a card", `card ${CARD}, exp 12/27`, "card_security"],
  ["expiry right after a card", `${CARD} 12/27 123`, "card_security"],
  ["passport number", `passport number: ${j("X123", "4567")}`, "passport"],
  ["passport no.", `My passport no. ${j("5", "12345678")}`.replace("5 ", "5"), "passport"],
  ["Canada SIN grouped", `her ${j("130", " 692 ", "544")} was on the form`, "ca_sin"],
  ["Canada SIN labeled", `SIN: ${j("130", "692", "544")}`, "ca_sin"],
  ["UK NI number", `NI ${j("AB", " 12 34 56 ", "C")}`, "uk_nino"],
  ["UK NI number, no spaces", `NINO ${j("AB", "123456", "C")}`, "uk_nino"],
  ["Aadhaar grouped", `${j("2345", " 6789 ", "0124")}`, "in_aadhaar"],
  ["Aadhaar labeled", `Aadhaar: ${j("2345", "6789", "0124")}`, "in_aadhaar"],
  ["OTP", "Your verification code is 482913.", "one_time_code"],
  ["OTP with service", "Your verification code for Acme is 482913", "one_time_code"],
  ["OTP, number first", "482913 is your login code", "one_time_code"],
  ["OTP word", "OTP: 4829", "one_time_code"],
  ["OTP split", "passcode 482 913", "one_time_code"],
  ["card followed by expiry (old miss)", `pay ${CARD} 12/27`, "card_number"],
  ["full-width digits", `routing ${"０２１００００２１"}, acct ${"1234567890"}`, "us_bank_account"],
];

/** Inputs that share a word or a shape and must not be found. */
const MUST_NOT_CATCH: [string, string][] = [
  ["UPS tracking number", "tracking 1Z999AA10123456784"],
  ["order number", "order 1234567890 shipped, order #A-99812"],
  ["phone number", "call +1 (415) 555-0132 or 415-555-0132 or +44 20 7946 0958"],
  ["ISBN", "ISBN 978-3-16-148410-0 and 0-306-40615-2"],
  ["git hash", "commit 9fceb02d0ae598e95dc970b74767f19372d61af8"],
  ["UUID", "id 123e4567-e89b-12d3-a456-426614174000"],
  ["price", "that costs $1,234.56 or 1.234,56 EUR"],
  ["date", "due 2026-11-18, 18/11/2026 and 12/27"],
  ["ZIP", "ship to 94105 or 94105-1234"],
  ["routing number alone", `our bank's routing number is ${j("0210", "00021")}`],
  ["account word alone", "your account 1234 is overdue; account number: 5551234"],
  ["cvv alone", "the cvv 123 is on the back"],
  ["zip / area / promo code", "zip code 94105, area code 415, promo code SAVE10 2024"],
  ["error code", "error code 5000 and status code 404"],
  [
    "passport without a number",
    "passport control was slow; the passport photo is ready; passport number is required",
  ],
  ["nine digits, no label", "id 130692544 in the table"],
  ["12-digit tracking number", "FedEx 234567890124"],
  ["version and ids", "v12.4.1 build 20261118 pr 1312"],
  ["code word in prose", "the source code is 100 lines; send the code in 5 minutes"],
  ["sin as a function", "sin 45 degrees"],
];

describe("outbound detectors: must catch", () => {
  it.each(MUST_CATCH)("%s", (_name, text, kind) => {
    expect(kinds(text)).toContain(kind);
  });
});

describe("outbound detectors: must not catch", () => {
  it.each(MUST_NOT_CATCH)("%s", (_name, text) => {
    expect(kinds(text)).toEqual([]);
  });
});

describe("outbound detectors: linear time", () => {
  const adversarial = [
    "1 ".repeat(40_000),
    "1-".repeat(40_000),
    "account ".repeat(10_000),
    "account 1 ".repeat(10_000),
    "routing 021000021 ".repeat(5_000),
    "passport ".repeat(10_000),
    "verification code ".repeat(10_000),
    "otp 1".repeat(15_000),
    "AB 12 34 56 ".repeat(8_000),
    "123 456 789 ".repeat(8_000),
    "2345 6789 0124 ".repeat(6_000),
    "a.".repeat(40_000),
    `${CARD} 12/27 `.repeat(2_000),
  ];
  it.each(adversarial.map((a, i) => [i, a] as const))("input %s finishes quickly", (_i, text) => {
    const start = performance.now();
    findSensitiveNormalized(text);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});
