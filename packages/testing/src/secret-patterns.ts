/**
 * Pattern detectors for values that must never be model-visible even when no test registered
 * them (security §4.4: card numbers by Luhn, bank accounts, government identifiers; §4.7 masking;
 * §15.4 item 7). Each detector trades recall for precision with a checksum or a nearby keyword,
 * because a checker that fires on order numbers gets disabled. Positive and negative samples live
 * in `tests/fixtures/secrets/registry.json` (`patternSamples`) and are tested in
 * `test/secret-patterns.test.ts`.
 */

export type PatternKind =
  | "card"
  | "us_ssn"
  | "iban"
  | "us_bank_account"
  | "passport"
  | "private_key_block";

export const PATTERN_KINDS: readonly PatternKind[] = [
  "card",
  "us_ssn",
  "iban",
  "us_bank_account",
  "passport",
  "private_key_block",
];

export interface PatternMatch {
  kind: PatternKind;
  /** Character offset of the match inside the scanned string. */
  offset: number;
  length: number;
}

/** Luhn checksum over the digits of `s` (non-digits ignored). */
export function luhnValid(s: string): boolean {
  const digits = s.replace(/\D/g, "");
  if (digits.length === 0) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Issuer prefixes and lengths of the major networks (Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay). */
function plausibleCard(digits: string): boolean {
  const n = digits.length;
  const p2 = Number(digits.slice(0, 2));
  const p4 = Number(digits.slice(0, 4));
  if (digits.startsWith("4")) return n === 13 || n === 16 || n === 19;
  if ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) return n === 16;
  if (p2 === 34 || p2 === 37) return n === 15;
  if (digits.startsWith("6011") || digits.startsWith("65") || /^64[4-9]/.test(digits))
    return n >= 16 && n <= 19;
  if (p4 >= 3528 && p4 <= 3589) return n >= 16 && n <= 19;
  if (p2 === 36 || p2 === 38 || /^30[0-5]/.test(digits)) return n >= 14 && n <= 19;
  if (digits.startsWith("62")) return n >= 16 && n <= 19;
  return false;
}

// 13–19 digits, optionally grouped by single spaces or hyphens, not glued to other digits, to
// letters or underscores (a digit run inside a hex hash or an id is not a card) or to a decimal
// point (the fraction of a float is not a card).
const CARD_RE = /(?<![\dA-Za-z_.-])\d(?:[ -]?\d){12,18}(?![\dA-Za-z_-]|\.\d)/g;

function findCards(text: string, out: PatternMatch[]): void {
  for (const m of text.matchAll(CARD_RE)) {
    const raw = m[0];
    // Mixed separators ("4242-4242 4242") are not how cards are written; dates and ids often are.
    if (raw.includes(" ") && raw.includes("-")) continue;
    const digits = raw.replace(/\D/g, "");
    if (plausibleCard(digits) && luhnValid(digits))
      out.push({ kind: "card", offset: m.index, length: raw.length });
  }
}

// Area 000, 666 and 900–999, group 00 and serial 0000 are never issued.
const SSN_RE = /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g;

function findSsns(text: string, out: PatternMatch[]): void {
  for (const m of text.matchAll(SSN_RE))
    out.push({ kind: "us_ssn", offset: m.index, length: m[0].length });
}

function ibanValid(iban: string): boolean {
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const chunk = code >= 65 ? String(code - 55) : ch;
    for (const d of chunk) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

const IBAN_RE = /(?<![A-Z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,32}/g;

function findIbans(text: string, out: PatternMatch[]): void {
  for (const m of text.matchAll(IBAN_RE)) {
    // The regex can run into a following uppercase word; try the whole match, then each prefix
    // that ends where a space follows, and keep the longest one that validates.
    const raw = m[0];
    for (let end = raw.length; end >= 15; end -= 1) {
      if (end < raw.length && raw[end] !== " ") continue;
      const candidate = raw.slice(0, end);
      if (ibanValid(candidate.replace(/ /g, ""))) {
        out.push({ kind: "iban", offset: m.index, length: candidate.length });
        break;
      }
    }
  }
}

function abaValid(d: string): boolean {
  if (!/^\d{9}$/.test(d)) return false;
  const n = [...d].map(Number) as number[];
  const sum =
    3 * ((n[0] ?? 0) + (n[3] ?? 0) + (n[6] ?? 0)) +
    7 * ((n[1] ?? 0) + (n[4] ?? 0) + (n[7] ?? 0)) +
    ((n[2] ?? 0) + (n[5] ?? 0) + (n[8] ?? 0));
  return sum % 10 === 0;
}

const ROUTING_RE = /\b(?:routing|aba|rtn)\b[^\d\n]{0,20}(\d{9})\b/gi;
const ACCOUNT_RE = /\b(?:account|acct)\b[^\d\n]{0,20}(\d{4,17})\b/gi;

/** A checksum-valid routing number next to an account number, both introduced by keywords. */
function findBankAccounts(text: string, out: PatternMatch[]): void {
  const accounts = [...text.matchAll(ACCOUNT_RE)];
  for (const r of text.matchAll(ROUTING_RE)) {
    if (!abaValid(r[1] ?? "")) continue;
    const near = accounts.find((a) => Math.abs(a.index - r.index) <= 80);
    if (near === undefined) continue;
    const start = Math.min(r.index, near.index);
    const end = Math.max(r.index + r[0].length, near.index + near[0].length);
    out.push({ kind: "us_bank_account", offset: start, length: end - start });
  }
}

const PASSPORT_RE = /\bpassport\b[^\n]{0,24}?\b([A-Z]?\d{8,9})\b/gi;

function findPassports(text: string, out: PatternMatch[]): void {
  for (const m of text.matchAll(PASSPORT_RE))
    out.push({ kind: "passport", offset: m.index, length: m[0].length });
}

// Built from parts so this file does not trip the repository's own secret-grep gate.
const PEM_RE = new RegExp(`-----BEGIN (?:[A-Z0-9]+ )*${"PRIVATE"} KEY-----`, "g");

function findPrivateKeys(text: string, out: PatternMatch[]): void {
  for (const m of text.matchAll(PEM_RE))
    out.push({ kind: "private_key_block", offset: m.index, length: m[0].length });
}

const DETECTORS: Record<PatternKind, (text: string, out: PatternMatch[]) => void> = {
  card: findCards,
  us_ssn: findSsns,
  iban: findIbans,
  us_bank_account: findBankAccounts,
  passport: findPassports,
  private_key_block: findPrivateKeys,
};

/** Every pattern hit in `text`, except kinds listed in `allow`. */
export function findPatterns(text: string, allow: readonly PatternKind[] = []): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const kind of PATTERN_KINDS) {
    if (allow.includes(kind)) continue;
    DETECTORS[kind](text, out);
  }
  return out.sort((a, b) => a.offset - b.offset);
}
