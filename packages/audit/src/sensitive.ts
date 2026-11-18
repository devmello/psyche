/**
 * Detectors for values that must never reach a model context, a log or the audit file (security
 * §1.1 goal 1, §3.9, §4.4): credential shapes, payment card numbers (Luhn), IBANs (mod 97) and US
 * social security numbers, and (outbound check, security §3.9) US routing plus account numbers, a
 * card's CVV and expiry, passport numbers, Canada SIN, UK National Insurance numbers, India
 * Aadhaar numbers and one-time codes. Used by audit redaction, by the Permission Broker's hard
 * prohibitions and by the outbound check on messages Psyche sends. Patterns are deliberately
 * specific (known prefixes, checksums, context words) so hashes, ids and ordinary numbers do not
 * match.
 */

export type SensitiveKind =
  | "private_key"
  | "api_key"
  | "bearer_token"
  | "jwt"
  | "url_credentials"
  | "card_number"
  | "iban"
  | "us_ssn"
  | "us_bank_account"
  | "card_security"
  | "passport"
  | "ca_sin"
  | "uk_nino"
  | "in_aadhaar"
  | "one_time_code";

export interface SensitiveMatch {
  kind: SensitiveKind;
  index: number;
  length: number;
}

// Every pattern that starts with a repeatable class is anchored by a negative lookbehind on that
// class, so a match can only start at the beginning of a run: linear time on adversarial input
// such as "a.a.a…" or "eyJ-eyJ-…" (the \b-anchored versions backtracked quadratically).
const CREDENTIAL_PATTERNS: { kind: SensitiveKind; re: RegExp }[] = [
  {
    kind: "private_key",
    re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g,
  },
  { kind: "api_key", re: /(?<![A-Za-z0-9_-])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "api_key", re: /(?<![A-Za-z0-9_])[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "api_key", re: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: "api_key", re: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}/g },
  { kind: "api_key", re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g },
  { kind: "api_key", re: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g },
  { kind: "api_key", re: /(?<![A-Za-z0-9-])xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "api_key", re: /(?<!\d)\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/g },
  { kind: "bearer_token", re: /\bBearer[ \t]+[A-Za-z0-9._~+/-]{20,}=*/g },
  {
    kind: "jwt",
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    kind: "url_credentials",
    re: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@"'<>]{1,256}:[^/\s@"'<>]{3,256}@/gi,
  },
];

/** 13–19 digits, optionally grouped by single spaces, dots, tabs or dashes. */
const CARD_CANDIDATE = /(?<!\d)\d(?:[ .\t-]?\d){12,18}(?!\d)/g;
const IBAN_CANDIDATE = /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]){11,30}(?![A-Za-z0-9])/g;
const SSN_CANDIDATE = /(?<!\d)(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}(?!\d)/g;

// ---- government and bank identifiers (outbound check) --------------------------------------------
// Each is anchored by a checksum, a context word or both, and by a lookbehind on its first class so
// it can only start at the beginning of a run (linear time, see above).

const ABA_CANDIDATE = /(?<![\d-])\d{9}(?![\d-])/g;
/** A word that labels an account number, then the number (4–17 digits, single separators). */
const ACCOUNT_LABELED =
  /(?<![A-Za-z0-9])(?:account|acct|acc|a\/c|checking|savings)(?:[ \t]{0,2}(?:number|no|num|#))?\.?[ \t]{0,2}(?:is[ \t]{0,2})?[:#=-]?[ \t]{0,2}(\d(?:[ -]?\d){3,16})(?!\d)/gi;
const ROUTING_WORD = /(?<![A-Za-z])(?:routing|aba|rtn|transit)(?![A-Za-z])/i;
const NINE_GROUPED = /(?<!\d|\d[- ])\d{3}[- ]\d{3}[- ]\d{3}(?!\d|[- ]\d)/g;
const SIN_LABELED =
  /(?<![A-Za-z0-9])(?:sin|social insurance(?: number)?)[ \t]{0,2}(?:no|number|#)?\.?[ \t]{0,2}(?:is[ \t]{0,2})?[:#=-]?[ \t]{0,2}(\d{3}[ -]?\d{3}[ -]?\d{3})(?!\d)/gi;
const PASSPORT =
  /(?<![A-Za-z0-9])passport(?:[ \t]{0,2}(?:number|no|num|#|id))?\.?[ \t]{0,2}(?:is[ \t]{0,2})?[:#=-]?[ \t]{0,2}((?=[A-Za-z0-9]{0,8}\d)[A-Za-z0-9]{6,9})(?![A-Za-z0-9])/gi;
const NINO =
  /(?<![A-Za-z0-9])(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z][ ]?\d{2}[ ]?\d{2}[ ]?\d{2}[ ]?[A-D](?![A-Za-z0-9])/gi;
const AADHAAR_GROUPED = /(?<!\d|\d[- ])[2-9]\d{3}[ -]\d{4}[ -]\d{4}(?!\d|[- ]\d)/g;
const AADHAAR_LABELED =
  /(?<![A-Za-z0-9])(?:aadhaar|aadhar|uidai|uid)[ \t]{0,2}(?:number|no|#|card)?\.?[ \t]{0,2}(?:is[ \t]{0,2})?[:#=-]?[ \t]{0,2}([2-9]\d{3}[ -]?\d{4}[ -]?\d{4})(?!\d)/gi;
const CVV_LABELED =
  /(?<![A-Za-z0-9])(?:cvv2?|cvc2?|cid|csc|cvn|security code|card code|verification value)(?:[ \t]{0,2}(?:number|no|#))?[ \t]{0,2}(?:is[ \t]{0,2})?[:#=-]?[ \t]{0,2}(\d{3,4})(?!\d)/gi;
const EXPIRY_LABELED =
  /(?<![A-Za-z0-9])(?:exp(?:iry|iration|ires)?|valid (?:thru|through|until)|good thru)(?:[ \t]{0,2}date)?[ \t.]{0,2}(?:is[ \t]{0,2})?[:#=-]?[ \t]{0,2}((?:0?[1-9]|1[0-2])[ \t]?[/-][ \t]?(?:\d{4}|\d{2}))(?!\d)/gi;
/** Straight after a card number: "… 12/27", then "… 123". */
const EXPIRY_AFTER = /^[ \t,;|/-]{1,4}((?:0[1-9]|1[0-2])[ \t]?\/[ \t]?(?:\d{4}|\d{2}))(?!\d)/;
const CVV_AFTER = /^[ \t,;|/-]{1,4}(\d{3,4})(?!\d)/;

const OTP_LABEL =
  "(?:otp|one[- ]time[ \\t]+(?:code|password|passcode|pin)|(?:verification|security|login|log[- ]in|sign[- ]?in|auth(?:entication)?|confirmation|access|reset|2fa|mfa|sms|authenticator)[ \\t]+(?:code|pin)|passcode|your[ \\t]+code)";
const OTP_AFTER = new RegExp(
  `(?<![A-Za-z0-9])${OTP_LABEL}(?:[ \\t]+for[ \\t]+[A-Za-z0-9._-]{1,30})?[ \\t]{0,2}(?:(?:is|was)[ \\t]{0,2})?[:=-]?[ \\t]{0,2}(?:G-)?(\\d{3}[ -]?\\d{3,5}|\\d{4,8})(?![\\dA-Za-z])`,
  "gi",
);
const OTP_BEFORE =
  /(?<![\d])(\d{4,8})(?![\dA-Za-z])[ \t]+(?:is|are)[ \t]+(?:your|the|ur)[ \t]+(?:[A-Za-z]+[ \t]+){0,2}(?:code|otp|passcode|pin)(?![A-Za-z])/gi;

/** US ABA routing number checksum (3-7-1 weights) and a valid Federal Reserve prefix. */
export function abaValid(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const d = [...digits].map(Number) as number[];
  const at = (i: number) => d[i] as number;
  const sum = 3 * (at(0) + at(3) + at(6)) + 7 * (at(1) + at(4) + at(7)) + (at(2) + at(5) + at(8));
  if (sum % 10 !== 0) return false;
  const prefix = Number(digits.slice(0, 2));
  return (
    prefix <= 12 ||
    (prefix >= 21 && prefix <= 32) ||
    (prefix >= 61 && prefix <= 72) ||
    prefix === 80
  );
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const rev = [...digits].reverse();
  for (const [i, ch] of rev.entries()) {
    const row = VERHOEFF_P[i % 8] as readonly number[];
    c = (VERHOEFF_D[c] as readonly number[])[row[Number(ch)] as number] as number;
  }
  return c === 0;
}

/** India Aadhaar: 12 digits, first 2–9, Verhoeff check digit. */
export function aadhaarValid(raw: string): boolean {
  const digits = raw.replace(/[ -]/g, "");
  return /^[2-9]\d{11}$/.test(digits) && !/^(\d)\1+$/.test(digits) && verhoeffValid(digits);
}

/** Canada SIN: 9 digits, Luhn, first digit 1–7 or 9 (0 is unassigned, 8 is not issued). */
export function sinValid(raw: string): boolean {
  const digits = raw.replace(/[ -]/g, "");
  return /^[1-79]\d{8}$/.test(digits) && !/^(\d)\1+$/.test(digits) && luhnValid(digits);
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function ibanValid(raw: string): boolean {
  const iban = raw.replace(/ /g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const chunk = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const c of chunk) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/** Card number digits (separators removed) when `candidate` is a Luhn-valid PAN. */
export function cardDigits(candidate: string): string | undefined {
  const digits = candidate.replace(/[ .\t-]/g, "");
  if (digits.length < 13 || digits.length > 19) return undefined;
  if (/^(\d)\1+$/.test(digits)) return undefined;
  return luhnValid(digits) ? digits : undefined;
}

/**
 * The Luhn-valid card number inside a digit run, which may have run into a following expiry or
 * code ("4111… 12/27") or a leading one: the longest group-aligned slice of 13–19 digits. The run
 * is at most 19 digits, so this stays bounded.
 */
function cardWithin(run: string): { start: number; length: number } | undefined {
  const isDigit = (i: number) => run.charCodeAt(i) >= 48 && run.charCodeAt(i) <= 57;
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < run.length; i += 1) {
    if (!isDigit(i)) continue;
    if (i === 0 || !isDigit(i - 1)) starts.push(i);
    if (i === run.length - 1 || !isDigit(i + 1)) ends.push(i);
  }
  for (const s of starts) {
    for (let k = ends.length - 1; k >= 0; k -= 1) {
      const e = ends[k] as number;
      if (e < s) break;
      if (cardDigits(run.slice(s, e + 1)) !== undefined) return { start: s, length: e + 1 - s };
    }
  }
  return undefined;
}

export function findSensitive(text: string): SensitiveMatch[] {
  const out: SensitiveMatch[] = [];
  for (const { kind, re } of CREDENTIAL_PATTERNS) {
    for (const m of text.matchAll(re)) {
      let length = m[0].length;
      if (kind === "private_key") {
        // The whole block, up to its END line (or the end of the text), found without backtracking.
        const end = text.indexOf("PRIVATE KEY-----", m.index + length);
        length = end === -1 ? text.length - m.index : end + "PRIVATE KEY-----".length - m.index;
      }
      out.push({ kind, index: m.index, length });
    }
  }
  for (const m of text.matchAll(CARD_CANDIDATE)) {
    const span = cardWithin(m[0]);
    if (span !== undefined) {
      out.push({ kind: "card_number", index: m.index + span.start, length: span.length });
    }
  }
  for (const m of text.matchAll(IBAN_CANDIDATE)) {
    // The candidate may run into a following word; take the longest prefix that validates.
    for (let end = m[0].length; end >= 15; end -= 1) {
      const head = m[0].slice(0, end);
      if (head.endsWith(" ")) continue;
      if (ibanValid(head)) {
        out.push({ kind: "iban", index: m.index, length: end });
        break;
      }
    }
  }
  for (const m of text.matchAll(SSN_CANDIDATE)) {
    out.push({ kind: "us_ssn", index: m.index, length: m[0].length });
  }
  findIdentifiers(text, out);
  return out.sort((a, b) => a.index - b.index || b.length - a.length);
}

/** The span of capture group 1, which every labeled pattern above ends with. */
function groupSpan(m: RegExpMatchArray): SensitiveMatch["index"] {
  return (m.index as number) + m[0].length - (m[1] as string).length;
}

function findIdentifiers(text: string, out: SensitiveMatch[]): void {
  const push = (kind: SensitiveKind, index: number, length: number) =>
    out.push({ kind, index, length });
  const covers = (kind: SensitiveKind, index: number) =>
    out.some((o) => o.kind === kind && o.index === index);

  // US bank account: a labeled routing number (ABA checksum) next to a labeled account number. A
  // routing number alone is public and an account word alone names utility bills, so neither counts.
  const routing: { index: number }[] = [];
  for (const m of text.matchAll(ABA_CANDIDATE)) {
    if (!abaValid(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    const after = text.slice(m.index + 9, m.index + 9 + 16);
    if (ROUTING_WORD.test(before) || ROUTING_WORD.test(after)) routing.push({ index: m.index });
  }
  if (routing.length > 0) {
    for (const m of text.matchAll(ACCOUNT_LABELED)) {
      const at = groupSpan(m);
      const near = routing.find((r) => Math.abs(r.index - at) <= 150);
      if (near === undefined || near.index === at) continue;
      push("us_bank_account", at, (m[1] as string).length);
      if (!covers("us_bank_account", near.index)) push("us_bank_account", near.index, 9);
    }
  }

  // A card's CVV and expiry, only next to a detected card (a lone "CVV 123" is not usable).
  const cards = out.filter((o) => o.kind === "card_number");
  if (cards.length > 0) {
    const near = (index: number, length: number) =>
      cards.some((c) => index < c.index + c.length + 100 && index + length > c.index - 100);
    for (const re of [CVV_LABELED, EXPIRY_LABELED]) {
      for (const m of text.matchAll(re)) {
        const at = groupSpan(m);
        if (near(at, (m[1] as string).length)) push("card_security", at, (m[1] as string).length);
      }
    }
    for (const c of cards) {
      let end = c.index + c.length;
      const expiry = EXPIRY_AFTER.exec(text.slice(end, end + 24));
      if (expiry === null) continue;
      const at = end + expiry[0].length - (expiry[1] as string).length;
      push("card_security", at, (expiry[1] as string).length);
      end += expiry[0].length;
      const cvv = CVV_AFTER.exec(text.slice(end, end + 12));
      if (cvv !== null) {
        push(
          "card_security",
          end + cvv[0].length - (cvv[1] as string).length,
          (cvv[1] as string).length,
        );
      }
    }
  }

  for (const m of text.matchAll(PASSPORT)) {
    push("passport", groupSpan(m), (m[1] as string).length);
  }
  for (const m of text.matchAll(SIN_LABELED)) {
    if (sinValid(m[1] as string)) push("ca_sin", groupSpan(m), (m[1] as string).length);
  }
  for (const m of text.matchAll(NINE_GROUPED)) {
    if (sinValid(m[0]) && !covers("ca_sin", m.index)) push("ca_sin", m.index, m[0].length);
  }
  for (const m of text.matchAll(NINO)) push("uk_nino", m.index, m[0].length);
  for (const m of text.matchAll(AADHAAR_LABELED)) {
    if (aadhaarValid(m[1] as string)) push("in_aadhaar", groupSpan(m), (m[1] as string).length);
  }
  for (const m of text.matchAll(AADHAAR_GROUPED)) {
    if (aadhaarValid(m[0]) && !covers("in_aadhaar", m.index)) {
      push("in_aadhaar", m.index, m[0].length);
    }
  }
  for (const m of text.matchAll(OTP_AFTER)) {
    push("one_time_code", groupSpan(m), (m[1] as string).length);
  }
  for (const m of text.matchAll(OTP_BEFORE)) {
    push("one_time_code", m.index, (m[1] as string).length);
  }
}

/**
 * Matches on the NFKC form with format characters removed, so full-width digits, zero-width
 * joiners and similar encodings are caught. Indices refer to the normalized text.
 */
export function findSensitiveNormalized(text: string): SensitiveMatch[] {
  const normalized = text.normalize("NFKC").replace(/[\p{Cf}]/gu, "");
  return normalized === text ? findSensitive(text) : findSensitive(normalized);
}

export function containsSensitive(text: string): boolean {
  return findSensitiveNormalized(text).length > 0;
}

export const REDACTED = "[redacted]";

/** Replace every sensitive match with `[redacted:<kind>]`. */
export function redactSensitive(text: string): string {
  const matches = findSensitive(text);
  if (matches.length === 0) {
    // Encoded forms (full-width digits, zero-width separators) redact the whole string.
    const hidden = findSensitiveNormalized(text)[0];
    return hidden === undefined ? text : `[redacted:${hidden.kind}]`;
  }
  let out = "";
  let at = 0;
  for (const m of matches) {
    if (m.index < at) continue;
    out += `${text.slice(at, m.index)}[redacted:${m.kind}]`;
    at = m.index + m.length;
  }
  return out + text.slice(at);
}
