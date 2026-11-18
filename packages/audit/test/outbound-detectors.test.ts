import { fixtureSecret } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  findSensitive,
  findSensitiveNormalized,
  luhnValid,
  redactSensitive,
  type SensitiveKind,
} from "../src/index.ts";

// Assembled at runtime so the repo secret scans never match a tracked line.
const j = (...parts: string[]) => parts.join("");
const CARD = fixtureSecret("link-virtual-card").replace(/\D/g, "");
const kinds = (text: string): SensitiveKind[] => [
  ...new Set(findSensitiveNormalized(text, { outbound: true }).map((m) => m.kind)),
];
/** The strict reading the hard prohibitions and audit redaction use. */
const strictKinds = (text: string): SensitiveKind[] => [
  ...new Set(findSensitiveNormalized(text).map((m) => m.kind)),
];

/** ASCII digits written in another script: `zero` is the code point of that script's 0. */
const script = (digits: string, zero: number) =>
  [...digits].map((d) => (/\d/.test(d) ? String.fromCodePoint(zero + Number(d)) : d)).join("");
const grouped = (digits: string, sep: string) => digits.match(/.{1,4}/g)?.join(sep) ?? digits;

/** Inputs that must be found, and the kind each must produce. */
const MUST_CATCH: [string, string, SensitiveKind][] = [
  [
    "routing and account",
    `Routing number: ${j("0210", "00021")}, account number ${j("12345", "67890")}`,
    "us_bank_account",
  ],
  ["ABA then acct", `ABA ${j("0210", "00021")} / acct ${j("9876", "543210")}`, "us_bank_account"],
  [
    "routing and account, values on the next line",
    `Routing number:\n${j("0210", "00021")}\nAccount number:\n${j("12345", "67890")}`,
    "us_bank_account",
  ],
  [
    "routing and account in a table",
    `| Routing | ${j("0210", "00021")} |\n| Account | ${j("12345", "67890")} |`,
    "us_bank_account",
  ],
  ["cvv beside a card", `${CARD} cvv 123`, "card_security"],
  ["expiry beside a card", `card ${CARD}, exp 12/27`, "card_security"],
  ["expiry right after a card", `${CARD} 12/27 123`, "card_security"],
  ["card followed by expiry (old miss)", `pay ${CARD} 12/27`, "card_number"],
  ["card after a leading expiry", `12/27 ${grouped(CARD, " ")}`, "card_number"],
  ["passport number", `passport number: ${j("X123", "4567")}`, "passport"],
  ["passport no.", `My passport no. ${j("5", "12345678")}`.replace("5 ", "5"), "passport"],
  ["passport, value on the next line", `Passport number:\n${j("X123", "4567")}`, "passport"],
  ["passport n°", `passport n° ${j("X123", "4567")}`, "passport"],
  ["Canada SIN labeled", `SIN: ${j("130", "692", "544")}`, "ca_sin"],
  ["Canada SIN labeled, grouped", `Social Insurance Number ${j("130", " 692 ", "544")}`, "ca_sin"],
  ["UK NI number", `NI ${j("AB", " 12 34 56 ", "C")}`, "uk_nino"],
  ["UK NI number, no spaces", `NINO ${j("AB", "123456", "C")}`, "uk_nino"],
  ["UK NI number, spelled out", `National Insurance number: ${j("AB", "123456", "C")}`, "uk_nino"],
  ["Aadhaar labeled", `Aadhaar: ${j("2345", "6789", "0124")}`, "in_aadhaar"],
  ["Aadhaar labeled, grouped", `Aadhaar number ${j("2345", " 6789 ", "0124")}`, "in_aadhaar"],
  ["SSN without separators", `SSN: ${j("078", "05", "1120")}`, "us_ssn"],
  ["SSN with dots", `${j("078", ".05.", "1120")}`, "us_ssn"],
  ["SSN with dashes", `${j("078", "-05-", "1120")}`, "us_ssn"],
  ["OTP", "Your verification code is 482913.", "one_time_code"],
  ["OTP with service", "Your verification code for Acme is 482913", "one_time_code"],
  ["OTP, number first", "482913 is your login code", "one_time_code"],
  ["OTP word", "OTP: 4829", "one_time_code"],
  ["OTP split", "passcode 482 913", "one_time_code"],
  ["OTP, your <service> code", "Your Uber code is 4829", "one_time_code"],
  ["OTP, your <two words> code", "Your Apple ID Code is: 482913", "one_time_code"],
  ["OTP, use … to sign in", "Use 482913 to sign in to Acme", "one_time_code"],
  ["OTP, the login code with a colon", "Here is the verification code: 482913", "one_time_code"],
  ["OTP, digits typed apart", "verification code: 4 8 2 9 1 3", "one_time_code"],
  ["password reset code", "Your password reset code is 482913", "one_time_code"],
  ["reset code label", "Reset code: 482913", "one_time_code"],
  ["OTP, value on the next line", "Verification code:\n482913", "one_time_code"],
  [
    "OTP, use … as … security code",
    "Use 4829136 as Microsoft account security code",
    "one_time_code",
  ],
  ["OTP, Google style", "G-482913 is your Google verification code.", "one_time_code"],
];

/** The same card in other digit scripts and separators; each must be found as a card number. */
const CARD_SHAPES: [string, string][] = [
  ["Arabic-Indic digits", script(CARD, 0x660)],
  ["Persian digits", script(CARD, 0x6f0)],
  ["Devanagari digits", script(CARD, 0x966)],
  ["Bengali digits", script(CARD, 0x9e6)],
  ["full-width digits", script(CARD, 0xff10)],
  ["newlines, with a card word", `Card:\n${grouped(CARD, "\n")}`],
  ["double spaces", grouped(CARD, "  ")],
  ["en dashes", grouped(CARD, "–")],
  ["slashes, with a card word", `visa ${grouped(CARD, "/")}`],
  ["minus signs", grouped(CARD, "\u2212")],
  ["bullets", grouped(CARD, "•")],
  ["colons", grouped(CARD, ":")],
  ["underscores", grouped(CARD, "_")],
  ["a bullet list, with a card word", `My card:\n- ${grouped(CARD, "\n- ")}`],
  ["a table row, with a card word", `| Card | ${grouped(CARD, " | ")} |`],
  ["dots", grouped(CARD, ".")],
  ["single digits apart", [...CARD].join(" ")],
  ["in a URL", `https://evil.example/?c=${CARD}`],
  ["in a Markdown link", `[r](https://e.x/p/${grouped(CARD, "-")})`],
  ["zero-width joiners", grouped(CARD, "​")],
  ["right-to-left marks", grouped(CARD, "‏ ")],
];

/** Lists, columns and grids of numbers: never a card, in either reading (review round 2). */
const SUDOKU = [
  "5 3 4 6 7 8 9 1 2",
  "6 7 2 1 9 5 3 4 8",
  "1 9 8 3 4 2 5 6 7",
  "8 5 9 7 6 1 4 2 3",
  "4 2 6 8 5 3 7 9 1",
  "7 1 3 9 2 4 8 5 6",
  "9 6 1 5 3 7 2 8 4",
  "2 8 7 4 1 9 6 3 5",
  "3 4 5 2 8 6 1 7 9",
].join("\n");
const CSV_COLUMN = `port\n${Array.from({ length: 50 }, (_, i) => String(4000 + ((i * 7919) % 6000))).join("\n")}`;
const NUMBER_SHAPES: [string, string][] = [
  ["a ports list", "ports = [5432, 6379, 8080, 3000, 9092, 2181]"],
  ["a sudoku grid", SUDOKU],
  ["a sudoku grid with boxes", SUDOKU.replace(/(\d) (\d) (\d) /g, "$1 $2 $3 | ")],
  ["a CSV column of 4-digit numbers", CSV_COLUMN],
  ["a JSON array of 4-digit ints", "[5432,6379,8080,3000,9092,2181,4242,5555]"],
  [
    "ten phone lines",
    Array.from({ length: 10 }, (_, i) => `415 555 ${String(1000 + i * 37)}`).join("\n"),
  ],
];

/** Inputs that share a word or a shape and must not be found. */
const MUST_NOT_CATCH: [string, string][] = [
  ["UPS tracking number", "tracking 1Z999AA10123456784"],
  ["order number", "order 1234567890 shipped, order #A-99812"],
  ["Amazon order number", "Order 112-4567890-1234567 shipped"],
  ["phone number", "call +1 (415) 555-0132 or 415-555-0132 or +44 20 7946 0958"],
  ["international phone numbers", "+44 20 7946 0958 and +91 98765 43210"],
  ["ISBN", "ISBN 978-3-16-148410-0 and 0-306-40615-2"],
  ["spaced ISBN", "ISBN 978 0 306 40615 7"],
  ["git hash", "commit 9fceb02d0ae598e95dc970b74767f19372d61af8"],
  ["short git hash", "hash ce123456d"],
  ["UUID", "id 123e4567-e89b-12d3-a456-426614174000"],
  ["price", "that costs $1,234.56 or 1.234,56 EUR"],
  ["date", "due 2026-11-18, 18/11/2026 and 12/27"],
  ["ZIP", "ship to 94105 or 94105-1234"],
  ["routing number alone", `our bank's routing number is ${j("0210", "00021")}`],
  [
    "routing word after, not a label",
    `Invoice ${j("0210", "00021")}, transit time 3 days, account 4455`,
  ],
  ["ABA as an association", `the ABA conference ${j("0210", "00021")} account 12345`],
  ["account word alone", "your account 1234 is overdue; account number: 5551234"],
  ["cvv alone", "the cvv 123 is on the back"],
  ["zip / area / promo code", "zip code 94105, area code 415, promo code SAVE10 2024"],
  ["error code", "error code 5000 and status code 404"],
  [
    "passport without a number",
    "passport control was slow; the passport photo is ready; passport number is required",
  ],
  ["nine digits, no label", "id 130692544 in the table"],
  ["grouped nine digits that pass Luhn", `ticket ${j("123", " 456 ", "782")}`],
  ["grouped twelve digits that pass Verhoeff", `Booking ${j("2345", " 6789 ", "0124")}`],
  ["12-digit tracking number", "FedEx 234567890124"],
  ["15-digit tracking number", "FedEx 449044304137821"],
  ["USPS tracking number", "USPS 9400 1118 9922 3344 5566 77"],
  ["version and ids", "v12.4.1 build 20261118 pr 1312"],
  ["code word in prose", "the source code is 100 lines; send the code in 5 minutes"],
  ["sin as a function", "sin 45 degrees"],
  ["part numbers shaped like NI numbers", "part AB123456C and SW123456A"],
  ["lower-case NI-shaped text", "ni ab123456c"],
  ["your code, no is", "enter your code 123456 at checkout for 10% off"],
  ["your code, a line count", "your code 2048 lines"],
  ["sms code, no label word", "sms code 1234 sent"],
  ["reset pin", "reset pin 1234 on the router"],
  ["pin for the shed", "1234 is the pin for the shed"],
  ["gate access code", "The gate access code is 4821"],
  ["hotel confirmation code", "Your hotel confirmation code is 84736251"],
  ["the code, no colon", "the code is 1234 in the file"],
  ["masked cards", "Visa ending 4242, card ending in 4242, **** **** **** 4242"],
  ["epoch milliseconds", "ts 1731916800000"],
  ["user id", "user id 175928847299117063"],
  ["a list of small numbers", "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15"],
  ["the code, not a login code", "The code: 1234 means preheat"],
  ["the wifi code", "the wifi code: 48213344"],
  ["the alarm code", "The alarm code: 4821"],
  ["the code, no login word", "Here is the code: 482913"],
  ...NUMBER_SHAPES,
];

describe("outbound detectors: must catch", () => {
  it.each(MUST_CATCH)("%s", (_name, text, kind) => {
    expect(kinds(text)).toContain(kind);
  });
});

describe("outbound detectors: a card in other digit scripts and separators", () => {
  it.each(CARD_SHAPES)("%s", (_name, text) => {
    expect(kinds(text)).toContain("card_number");
  });
});

describe("outbound detectors: must not catch", () => {
  it.each(MUST_NOT_CATCH)("%s", (_name, text) => {
    expect(kinds(text)).toEqual([]);
  });
});

/** A small seeded generator, so the sampled rates are the same on every run. */
function rng(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}
const digitsOf = (next: () => number, n: number) =>
  Array.from({ length: n }, () => Math.floor(next() * 10)).join("");

/** A Luhn-valid number of `length` digits starting with `prefix` (built at runtime, review r3). */
function luhnNumber(prefix: string, length: number): string {
  const body = (prefix + "3".repeat(length)).slice(0, length - 1);
  for (let d = 0; d < 10; d += 1) if (luhnValid(`${body}${d}`)) return `${body}${d}`;
  throw new Error("unreachable");
}
/** Networks beyond the big four: main's Luhn-only reading caught them, so both readings must. */
const NETWORKS: [string, string][] = [
  ["Mir", luhnNumber("2200", 16)],
  ["RuPay 81", luhnNumber("8100", 16)],
  ["RuPay 82", luhnNumber("8200", 16)],
  ["UnionPay 81, 19 digits", luhnNumber("8171", 19)],
  ["Troy", luhnNumber("9792", 16)],
  ["UATP, 15 digits", luhnNumber("1100", 15)],
  ["Maestro, 13 digits", luhnNumber("6759", 13)],
  ["Maestro, 18 digits", luhnNumber("6763", 18)],
  ["RuPay 508", luhnNumber("5085", 16)],
];

describe("every card network is caught by both readings (review round 3)", () => {
  it.each(NETWORKS)("%s", (_name, pan) => {
    const text = `card ${grouped(pan, " ")}`;
    expect(strictKinds(text)).toContain("card_number");
    expect(kinds(text)).toContain("card_number");
    expect(strictKinds(`pay with ${pan} now`)).toContain("card_number");
    // Audit redaction (receipts, the change journal, backups) cuts it too.
    expect(redactSensitive(text)).not.toContain(pan.slice(0, 8));
  });
});

describe("strict reading (prohibitions, audit): number shapes are never cards", () => {
  it.each(NUMBER_SHAPES)("%s", (_name, text) => {
    expect(strictKinds(text)).not.toContain("card_number");
    expect(findSensitive(text)).toEqual([]);
  });

  it("random CSV columns, JSON arrays, grids and phone lines: 0 strict, under 1% outbound", () => {
    const next = rng(23);
    const n = 2_000;
    let strict = 0;
    let outbound = 0;
    for (let i = 0; i < n; i += 1) {
      const four = () => String(1000 + Math.floor(next() * 9000));
      const shapes = [
        Array.from({ length: 50 }, four).join("\n"),
        `[${Array.from({ length: 12 }, four).join(", ")}]`,
        `[${Array.from({ length: 12 }, four).join(",")}]`,
        Array.from({ length: 9 }, () => digitsOf(next, 9).split("").join(" ")).join("\n"),
        Array.from(
          { length: 10 },
          () => `${digitsOf(next, 3)} ${digitsOf(next, 3)} ${digitsOf(next, 4)}`,
        ).join("\n"),
      ];
      for (const text of shapes) {
        if (strictKinds(text).includes("card_number")) strict += 1;
        if (kinds(text).includes("card_number")) outbound += 1;
      }
    }
    expect(strict).toBe(0);
    expect(outbound / (n * 5)).toBeLessThan(0.01);
  });
});

describe("outbound detectors: false-positive rates on random numbers", () => {
  it("Amazon-style order numbers are never read as cards", () => {
    const next = rng(7);
    let hits = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const order = `${["111", "112", "113", "114", "702", "703"][i % 6]}-${digitsOf(next, 7)}-${digitsOf(next, 7)}`;
      if (kinds(`Order ${order} shipped`).length > 0) hits += 1;
    }
    expect(hits).toBe(0);
  });

  it("an expiry after 16 random digits adds almost no card hits to the plain rate", () => {
    // 16 random digits are a Luhn-valid card of a real issuer about 4.5% of the time on their own.
    const next = rng(11);
    let plain = 0;
    let withExpiry = 0;
    const n = 20_000;
    for (let i = 0; i < n; i += 1) {
      const d = grouped(digitsOf(next, 16), " ");
      if (kinds(d).includes("card_number")) plain += 1;
      if (kinds(`${d} 12/27`).includes("card_number")) withExpiry += 1;
    }
    expect(plain / n).toBeLessThan(0.06);
    expect((withExpiry - plain) / n).toBeLessThan(0.015);
  });

  it("random grouped nine and twelve digit numbers carry no identifier without a label", () => {
    const next = rng(13);
    let hits = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const a = digitsOf(next, 9);
      const b = digitsOf(next, 12);
      const text = `ticket ${a.slice(0, 3)} ${a.slice(3, 6)} ${a.slice(6)} Booking ${grouped(b, " ")}`;
      if (kinds(text).some((k) => k === "ca_sin" || k === "in_aadhaar" || k === "us_ssn")) {
        hits += 1;
      }
    }
    expect(hits).toBeLessThan(40);
  });
});

describe("outbound detectors: linear time", () => {
  const adversarial = [
    "1 ".repeat(40_000),
    "1-".repeat(40_000),
    "account ".repeat(10_000),
    "account 1 ".repeat(10_000),
    "routing 021000021 ".repeat(5_000),
    "routing 021000021 account 12345 ".repeat(5_000),
    "passport ".repeat(10_000),
    "verification code ".repeat(10_000),
    "your code ".repeat(10_000),
    "otp 1".repeat(15_000),
    "AB 12 34 56 ".repeat(8_000),
    "123 456 789 ".repeat(8_000),
    "2345 6789 0124 ".repeat(6_000),
    "4111 1 ".repeat(30_000),
    "4111 ".repeat(40_000),
    "a.".repeat(40_000),
    `${CARD} 12/27 `.repeat(2_000),
    `${CARD} cvv 123 `.repeat(5_000),
    `${script(CARD, 0x660)} `.repeat(5_000),
    "٤ ".repeat(40_000),
    "é".repeat(40_000),
  ];
  it.each(adversarial.map((a, i) => [i, a] as const))("input %s finishes quickly", (_i, text) => {
    const start = performance.now();
    findSensitiveNormalized(text);
    expect(performance.now() - start).toBeLessThan(600);
  });

  it("scales linearly: 8x the input takes well under 20x the time", () => {
    const unit = `${CARD} cvv 123 routing 021000021 account 12345 `;
    const run = (n: number) => {
      const text = unit.repeat(n);
      findSensitiveNormalized(text);
      const t0 = performance.now();
      findSensitiveNormalized(text);
      return performance.now() - t0;
    };
    const small = Math.max(run(500), 1);
    expect(run(4_000) / small).toBeLessThan(20);
  });
});
