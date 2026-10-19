/**
 * Entry-time refusals (security §4.4, feature G2): raw card numbers, CVVs, bank account
 * numbers and government identifiers are never stored, in any field, including notes and
 * names. Reports name the category, never the matched value.
 */

export type RefusalCategory =
  | "card_number"
  | "card_security_code"
  | "bank_account"
  | "government_id";

export interface Refusal {
  category: RefusalCategory;
  /** Which input field held it (`password`, `text`, `name`, a CSV column). */
  field: string;
}

export const REFUSAL_EXPLANATION =
  "Psyche does not store card numbers, card security codes, bank account numbers or government " +
  "identifiers. For payments, pair Stripe Link in Settings → Payments: each approved purchase " +
  "gets a one-time card that is never saved.";

/** Luhn checksum over a digit string. */
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
  return sum % 10 === 0;
}

/** Issuer prefixes (IIN ranges) of the major networks, so random digit passwords are not refused. */
function knownIssuer(d: string): boolean {
  const n2 = Number(d.slice(0, 2));
  const n3 = Number(d.slice(0, 3));
  const n4 = Number(d.slice(0, 4));
  const n6 = Number(d.slice(0, 6));
  const len = d.length;
  if (d.startsWith("4")) return len === 13 || len === 16 || len === 19; // Visa
  if ((n2 >= 51 && n2 <= 55) || (n4 >= 2221 && n4 <= 2720)) return len === 16; // Mastercard
  if (n2 === 34 || n2 === 37) return len === 15; // Amex
  if (n4 === 6011 || n2 === 65 || (n3 >= 644 && n3 <= 649) || (n6 >= 622126 && n6 <= 622925)) {
    return len >= 16 && len <= 19; // Discover
  }
  if (n4 >= 3528 && n4 <= 3589) return len >= 16 && len <= 19; // JCB
  if (n2 === 36 || n2 === 38 || (n3 >= 300 && n3 <= 305) || n2 === 39) return len >= 14; // Diners
  if (n2 === 62) return len >= 16 && len <= 19; // UnionPay
  if (n2 === 50 || (n2 >= 56 && n2 <= 69)) return len >= 12 && len <= 19; // Maestro
  return false;
}

/** 13–19 digits, optionally grouped by single spaces or dashes. */
const CARD_RE = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;
const CVV_RE =
  /\b(?:cvv2?|cvc2?|cid|csc|card\s*security\s*code|security\s*code)\b\s*[:=#-]?\s*\d{3,4}\b/i;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;
const SSN_RE = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/;
const UK_NINO_RE =
  /\b(?![DFIQUV])[A-CEGHJ-PR-TW-Z](?![DFIQUVO])[A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/;
const GOV_KEYWORD_RE =
  /\b(?:passport|social\s*security|ssn|driver'?s?\s*licen[cs]e|national\s*(?:id|identity|insurance)|tax\s*(?:id|number)|aadhaar|personnummer|steuer-?id)\b[^\n]{0,24}?\b(?=[A-Z0-9-]*\d{5})[A-Z0-9-]{6,}\b/i;
const BANK_KEYWORD_RE =
  /\b(?:routing|aba|sort\s*code|bsb|account\s*(?:number|no\.?|#))\b[^\n]{0,16}?\b\d[\d -]{5,20}\d\b/i;

function ibanValid(raw: string): boolean {
  const s = raw.replace(/ /g, "");
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const val = code >= 65 ? String(code - 55) : ch;
    for (const digit of val) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

/** The first refused category found in `text`, if any. */
export function scanText(text: string): RefusalCategory | null {
  for (const m of text.matchAll(CARD_RE)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && knownIssuer(digits) && luhnValid(digits)) {
      return "card_number";
    }
  }
  if (CVV_RE.test(text)) return "card_security_code";
  for (const m of text.toUpperCase().matchAll(IBAN_RE)) {
    if (ibanValid(m[0])) return "bank_account";
  }
  if (BANK_KEYWORD_RE.test(text)) return "bank_account";
  if (SSN_RE.test(text) || UK_NINO_RE.test(text) || GOV_KEYWORD_RE.test(text)) {
    return "government_id";
  }
  return null;
}

/** Field names that mean card / bank / id data whatever their value (CSV columns, custom fields). */
const REFUSED_FIELD_NAME =
  /^(?:card[\s_-]*(?:number|no)|cc[\s_-]*(?:number|num)|cvv2?|cvc2?|csc|security[\s_-]*code|expir(?:y|ation)(?:[\s_-]*date)?|iban|routing[\s_-]*number|account[\s_-]*number|ssn|passport[\s_-]*number|license[\s_-]*number)$/i;

export function refusedFieldName(name: string): RefusalCategory | null {
  if (!REFUSED_FIELD_NAME.test(name.trim())) return null;
  const n = name.toLowerCase();
  if (/cvv|cvc|csc|security/.test(n)) return "card_security_code";
  if (/iban|routing|account/.test(n)) return "bank_account";
  if (/ssn|passport|license/.test(n)) return "government_id";
  return "card_number";
}

/** Scan every value; the first hit wins. */
export function findRefusal(values: Record<string, string | undefined>): Refusal | null {
  for (const [field, value] of Object.entries(values)) {
    if (value === undefined || value.length === 0) continue;
    const category = scanText(value);
    if (category !== null) return { category, field };
  }
  return null;
}
