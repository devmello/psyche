/**
 * Detectors for values that must never reach a model context, a log or the audit file (security
 * §1.1 goal 1, §3.9, §4.4): credential shapes, payment card numbers (Luhn), IBANs (mod 97) and US
 * social security numbers. Used by audit redaction and by the Permission Broker's hard
 * prohibitions. Patterns are deliberately specific (known prefixes, checksums) so hashes, ids and
 * ordinary numbers do not match.
 */

export type SensitiveKind =
  | "private_key"
  | "api_key"
  | "bearer_token"
  | "jwt"
  | "url_credentials"
  | "card_number"
  | "iban"
  | "us_ssn";

export interface SensitiveMatch {
  kind: SensitiveKind;
  index: number;
  length: number;
}

const CREDENTIAL_PATTERNS: { kind: SensitiveKind; re: RegExp }[] = [
  {
    kind: "private_key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { kind: "api_key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "api_key", re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "api_key", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: "api_key", re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { kind: "api_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "api_key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "api_key", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "api_key", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { kind: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "url_credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"'<>]+:[^/\s@"'<>]{3,}@/g },
];

/** 13–19 digits, optionally grouped by single spaces or dashes. */
const CARD_CANDIDATE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
const SSN_CANDIDATE = /(?<!\d)(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?!\d)/g;

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
  const iban = raw.replace(/ /g, "");
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
  const digits = candidate.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19) return undefined;
  if (/^(\d)\1+$/.test(digits)) return undefined;
  return luhnValid(digits) ? digits : undefined;
}

export function findSensitive(text: string): SensitiveMatch[] {
  const out: SensitiveMatch[] = [];
  for (const { kind, re } of CREDENTIAL_PATTERNS) {
    for (const m of text.matchAll(re)) out.push({ kind, index: m.index, length: m[0].length });
  }
  for (const m of text.matchAll(CARD_CANDIDATE)) {
    if (cardDigits(m[0]) !== undefined) {
      out.push({ kind: "card_number", index: m.index, length: m[0].length });
    }
  }
  for (const m of text.matchAll(IBAN_CANDIDATE)) {
    if (ibanValid(m[0])) out.push({ kind: "iban", index: m.index, length: m[0].length });
  }
  for (const m of text.matchAll(SSN_CANDIDATE)) {
    out.push({ kind: "us_ssn", index: m.index, length: m[0].length });
  }
  return out.sort((a, b) => a.index - b.index || b.length - a.length);
}

export function containsSensitive(text: string): boolean {
  return findSensitive(text).length > 0;
}

export const REDACTED = "[redacted]";

/** Replace every sensitive match with `[redacted:<kind>]`. */
export function redactSensitive(text: string): string {
  const matches = findSensitive(text);
  if (matches.length === 0) return text;
  let out = "";
  let at = 0;
  for (const m of matches) {
    if (m.index < at) continue;
    out += `${text.slice(at, m.index)}[redacted:${m.kind}]`;
    at = m.index + m.length;
  }
  return out + text.slice(at);
}
