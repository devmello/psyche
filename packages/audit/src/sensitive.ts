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

const IBAN_CANDIDATE = /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]){11,30}(?![A-Za-z0-9])/g;

/** IBAN length per country (ISO 13616 registry). A candidate must have its country's length. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.fromEntries(
  (
    "AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BI27 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DJ27 " +
    "DK18 DO28 EE20 EG29 ES24 FI18 FK18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HN28 HR21 HU28 " +
    "IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20 LV21 LY25 MC27 MD24 ME22 " +
    "MK19 MN20 MR27 MT31 MU30 NI28 NL18 NO15 OM23 PK24 PL28 PS29 PT25 QA29 RO24 RS22 RU33 SA24 " +
    "SC31 SD18 SE24 SI19 SK24 SM27 SO23 ST25 SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20 YE30"
  )
    .split(" ")
    .map((e) => [e.slice(0, 2), Number(e.slice(2))]),
);

/**
 * Whether a checksum-valid candidate is shaped like an IBAN: a registry country with its exact
 * length, and not a lowercase hex digest (`ed25519:dc2669c91af935bc`, a hash): about 1 in 97
 * hex strings passes mod 97 by chance.
 */
export function ibanShaped(raw: string): boolean {
  const compact = raw.replace(/ /g, "");
  if (IBAN_LENGTHS[compact.slice(0, 2).toUpperCase()] !== compact.length) return false;
  const bban = compact.slice(4);
  return !(/^[0-9a-f]+$/.test(bban) && /[a-f]/.test(bban));
}
const SSN_CANDIDATE = /(?<!\d)(?!000|666|9\d\d)\d{3}[-. ](?!00)\d{2}[-. ](?!0000)\d{4}(?!\d)/g;

// ---- government and bank identifiers (outbound check) --------------------------------------------
// Each is anchored by a checksum, a context word or both, and by a lookbehind on its first class so
// it can only start at the beginning of a run (linear time, see above). Between a label and its
// value there may be a few spaces, a newline, a colon or a table pipe ("Account:\n123", "| SSN | 078…").
const JOIN = "[\\s|:#=.-]{0,4}";
const LABEL_NUMBER = "(?:[\\s|]{0,2}(?:number|no|num|n[°º]|#|id))?";

const ABA_CANDIDATE = /(?<![\d-])\d{9}(?![\d-])/g;
/** A word that labels an account number, then the number (4–17 digits, single separators). */
const ACCOUNT_LABELED = new RegExp(
  `(?<![A-Za-z0-9])(?:account|acct|acc|a\\/c|checking|savings)${LABEL_NUMBER}${JOIN}(?:is${JOIN})?(\\d(?:[ -]?\\d){3,16})(?!\\d)`,
  "gi",
);
/** The routing label, directly before the nine digits ("routing number: 0210…") or after them. */
const ROUTING_BEFORE =
  /(?<![A-Za-z])(?:routing|aba|rtn)(?:[ \t]+(?:transit|number|no\.?|num|#))*[\s|:#=.-]{0,4}$/i;
const ROUTING_AFTER =
  /^[ \t(,:-]{0,3}(?:(?:is|as)[ \t]+)?(?:(?:my|our|the)[ \t]+)?(?:routing|aba|rtn)(?![A-Za-z])/i;
const SSN_LABELED = new RegExp(
  `(?<![A-Za-z0-9])(?:ssn|social security(?:[ \\t]+(?:number|no\\.?))?)${JOIN}(?:is${JOIN})?(\\d{3}[-. ]?\\d{2}[-. ]?\\d{4})(?!\\d)`,
  "gi",
);
const SIN_LABELED = new RegExp(
  `(?<![A-Za-z0-9])(?:sin|social insurance(?:[ \\t]+number)?)${LABEL_NUMBER}${JOIN}(?:is${JOIN})?(\\d{3}[ -]?\\d{3}[ -]?\\d{3})(?!\\d)`,
  "gi",
);
const PASSPORT = new RegExp(
  `(?<![A-Za-z0-9])passport${LABEL_NUMBER}${JOIN}(?:is${JOIN})?((?=[A-Za-z0-9]{0,8}\\d)[A-Za-z0-9]{6,9})(?![A-Za-z0-9])`,
  "gi",
);
/** UK National Insurance number: the label is case-insensitive, the number is upper case. */
const NINO_LABEL = new RegExp(
  `(?<![A-Za-z0-9])(?:national insurance(?:[ \\t]+(?:number|no\\.?))?|NINO?|N\\.I\\.(?:[ \\t]+(?:number|no\\.?))?|NI(?:[ \\t]+(?:number|no\\.?))?)${JOIN}`,
  "gi",
);
const NINO_VALUE =
  /(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z][ ]?\d{2}[ ]?\d{2}[ ]?\d{2}[ ]?[A-D](?![A-Za-z0-9])/y;
const AADHAAR_LABELED = new RegExp(
  `(?<![A-Za-z0-9])(?:aadhaar|aadhar|uidai|uid)(?:[\\s|]{0,2}(?:number|no|card|#))?${JOIN}(?:is${JOIN})?([2-9]\\d{3}[ -]?\\d{4}[ -]?\\d{4})(?!\\d)`,
  "gi",
);
const CVV_LABELED = new RegExp(
  `(?<![A-Za-z0-9])(?:cvv2?|cvc2?|cid|csc|cvn|security code|card code|verification value)(?:[\\s|]{0,2}(?:number|no|#))?${JOIN}(?:is${JOIN})?(\\d{3,4})(?!\\d)`,
  "gi",
);
const EXPIRY_LABELED = new RegExp(
  `(?<![A-Za-z0-9])(?:exp(?:iry|iration|ires)?|valid (?:thru|through|until)|good thru)(?:[\\s|]{0,2}date)?${JOIN}(?:is${JOIN})?((?:0?[1-9]|1[0-2])[ \\t]?[/-][ \\t]?(?:\\d{4}|\\d{2}))(?!\\d)`,
  "gi",
);
/** Straight after a card number: "… 12/27", then "… 123". */
const EXPIRY_AFTER = /^[ \t,;|/-]{1,4}((?:0[1-9]|1[0-2])[ \t]?\/[ \t]?(?:\d{4}|\d{2}))(?!\d)/;
const CVV_AFTER = /^[ \t,;|/-]{1,4}(\d{3,4})(?!\d)/;

// One-time codes. A label that is only ever a login code ("verification code", "otp") may be
// followed by the value directly; "your … code" and "the … code" need an "is" or a colon, and
// words that name something else (a hotel confirmation, a gate or door code, a promo code) cancel it.
// The value: 6 digits, 3+3, 4–8 digits, or digits typed one apart ("4 8 2 9 1 3").
const OTP_VALUE = "(?:G-)?(\\d{3}[ -]?\\d{3,5}|\\d{4,8}|\\d(?: \\d){3,7})(?![\\dA-Za-z])";
const OTP_LABEL =
  "(?:otp|one[- ]time[ \\t]+(?:code|password|passcode|pin)|(?:verification|security|login|log[- ]in|sign[- ]?in|auth(?:entication)?|2fa|mfa|authenticator)[ \\t]+(?:code|pin)|(?:password[ \\t]+)?reset[ \\t]+code|passcode)";
const OTP_AFTER = new RegExp(
  `(?<![A-Za-z0-9])${OTP_LABEL}(?:[ \\t]+for[ \\t]+[A-Za-z0-9._-]{1,30})?\\s{0,3}(?:(?:is|was)[ \\t]{0,2})?[:=-]?\\s{0,3}${OTP_VALUE}`,
  "gi",
);
const YOUR_CODE = new RegExp(
  `(?<![A-Za-z0-9])your[ \\t]+((?:[A-Za-z0-9]+[ \\t]+){0,2})code[ \\t]{0,2}(?:(?:is|was)[ \\t]{0,2}:?|:)\\s{0,3}${OTP_VALUE}`,
  "gi",
);
const THE_CODE = new RegExp(
  `(?<![A-Za-z0-9])the[ \\t]+((?:[A-Za-z0-9]+[ \\t]+){0,2})code[ \\t]{0,2}:\\s{0,3}${OTP_VALUE}`,
  "gi",
);
/** "the … code:" counts only for a login code ("the verification code: 482913"). */
const LOGIN_WORD =
  /(?<![A-Za-z])(?:verification|verify|login|log[ -]?in|sign[ -]?in|security|one[ -]time|2fa|mfa|otp|auth|authentication|reset)(?![A-Za-z])/i;
const NOT_A_LOGIN_CODE =
  /^(?:.*\b)?(?:confirmation|booking|reservation|reference|order|tracking|access|gate|door|locker|promo|promotional|discount|coupon|voucher|gift|referral|zip|postal|area|country|hotel|flight|ticket|product|item|error|status|source)\b/i;
const OTP_USE =
  /(?<![A-Za-z0-9])use[ \t]+(\d{4,8})[ \t]+(?:to[ \t]+(?:sign|log)[ \t-]?in\b|to[ \t]+(?:verify|confirm|authenticate)\b|as[ \t]+(?:[A-Za-z]+[ \t]+){0,4}(?:code|otp|passcode)(?![A-Za-z]))/gi;
const OTP_BEFORE =
  /(?<![\d])(\d{4,8})(?![\dA-Za-z])[ \t]+(?:is|are)[ \t]+(?:your|ur)[ \t]+(?:[A-Za-z]+[ \t]+){0,2}(?:code|otp|passcode)(?![A-Za-z])/gi;

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

/**
 * Issuer prefixes (IIN ranges) and lengths of the card networks, for the outbound reading only: it
 * cuts false matches in prose. Never used to let a Luhn-valid number through the strict reading.
 */
export function cardIssuerValid(d: string): boolean {
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
  if (n2 === 50 || (n2 >= 56 && n2 <= 58) || d.startsWith("6")) return len >= 12 && len <= 19; // Maestro, RuPay 60/65/508
  if (n4 >= 2200 && n4 <= 2204) return len >= 16 && len <= 19; // Mir
  if (n2 === 81) return len >= 16 && len <= 19; // RuPay, UnionPay (2020+)
  if (n2 === 82) return len === 16; // RuPay
  if (n4 === 9792) return len === 16; // Troy
  if (d.startsWith("1")) return len === 15; // UATP
  return false;
}

/**
 * Card number digits (separators removed) when `candidate` is a Luhn-valid PAN, as on main. The
 * outbound reading also asks `cardIssuerValid`; the strict reading does not, so no network is missed.
 */
export function cardDigits(candidate: string): string | undefined {
  const digits = candidate.replace(/[\s\p{Pd}|/_,.·•:\u2212]/gu, "");
  if (digits.length < 13 || digits.length > 19) return undefined;
  if (/^(\d)\1+$/.test(digits)) return undefined;
  return luhnValid(digits) ? digits : undefined;
}

const isDigitAt = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  return c >= 48 && c <= 57;
};

/** ASCII letters and digits. */
const isAlnumAt = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
};

/** Longest token scanned on either side of a candidate; a longer one is never an identifier. */
const TOKEN_SCAN = 512;
const HEX_ID = /^[0-9a-fA-F]{32,}$/;
const ULID_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when the token around a card-length digit run [start, end) is an identifier, not a card: a
 * hex digest or git sha (32+ hex characters), a ULID, or a canonical UUID with its dashes (so an
 * all-digit UUID counts). The token is the maximal run of letters and digits around the candidate,
 * and for the UUID shape, that run plus dashes. Any other neighbour, such as a letter that makes
 * "4111111111111111a" or "x4111111111111111", leaves the candidate a card.
 */
function isIdToken(text: string, start: number, end: number): boolean {
  const n = text.length;
  let l = start;
  while (l > 0 && isAlnumAt(text, l - 1)) {
    l -= 1;
    if (start - l > TOKEN_SCAN) return false;
  }
  let r = end;
  while (r < n && isAlnumAt(text, r)) {
    r += 1;
    if (r - end > TOKEN_SCAN) return false;
  }
  const word = text.slice(l, r);
  if (HEX_ID.test(word) || ULID_ID.test(word)) return true;
  let dl = start;
  while (dl > 0 && (isAlnumAt(text, dl - 1) || text.charCodeAt(dl - 1) === 45)) {
    dl -= 1;
    if (start - dl > TOKEN_SCAN) return false;
  }
  let dr = end;
  while (dr < n && (isAlnumAt(text, dr) || text.charCodeAt(dr) === 45)) {
    dr += 1;
    if (dr - end > TOKEN_SCAN) return false;
  }
  return UUID_ID.test(text.slice(dl, dr));
}

/**
 * 13–19 digits, optionally grouped by single spaces, dots, tabs or dashes (the strict reading).
 * A run touching a digit is never a candidate; one touching a letter is skipped only when its
 * token is an identifier shape (see `isIdToken`).
 */
const CARD_CANDIDATE = /(?<!\d)\d(?:[ .\t-]?\d){12,18}(?!\d)/g;

/**
 * Characters people put between card-number groups in a message: spaces, dashes and minus signs,
 * dots, underscores, bullets, colons, and (only next to a card word) newlines, pipes and slashes.
 * Never a comma: lists of numbers ("ports = [5432, 6379, …]") are not cards.
 */
function isCardSep(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return (
      c === 32 ||
      (c >= 9 && c <= 13) ||
      c === 45 ||
      c === 124 ||
      c === 47 ||
      c === 95 ||
      c === 46 ||
      c === 58
    );
  }
  return c === 0xb7 || c === 0x2022 || c === 0x2212 || /[\s\p{Pd}]/u.test(ch);
}
/** Separators that also split lines, table cells and paths: a card word must be near. */
const WEAK_SEP = /[\n\r\v\f|/\u2028\u2029]/;
const CARD_WORD =
  /(?<![A-Za-z])(?:cards?|visa|master ?card|amex|american express|cc|pan|credit|debit|discover|maestro|jcb|unionpay)(?![A-Za-z])/i;

/**
 * Card numbers in a message (the outbound reading): digit groups joined by 1–3 separator
 * characters, read as a chain. A card is a run of whole groups totalling 13–19 digits with a Luhn
 * checksum and a real issuer prefix, joined by one and the same separator, and either grouped the
 * way cards are (first group of 4, 6, 8 or 12+ digits) or evenly spaced on one line ("4 1 1 1 …").
 * A newline, pipe or slash separator needs a card word within 40 characters, so a column of
 * numbers, a table or a grid is not a card. Order numbers like "112-4567890-1234567" start with a
 * short group and are never read as cards. Linear: each start looks at most 19 digits ahead.
 */
function cardMatches(text: string, skipIds: boolean): { start: number; length: number }[] {
  const found: { start: number; length: number }[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (!isDigitAt(text, i) || (i > 0 && isDigitAt(text, i - 1))) {
      i += 1;
      continue;
    }
    const gs: number[] = []; // [start, end) pairs of the chain's digit groups
    const gaps: string[] = [];
    let digits = "";
    let p = i;
    for (;;) {
      let q = p;
      while (q < n && isDigitAt(text, q)) q += 1;
      gs.push(p, q);
      digits += text.slice(p, q);
      let g = q;
      while (g < n && g - q < 4 && isCardSep(text.charAt(g))) g += 1;
      if (g - q >= 1 && g - q <= 3 && g < n && isDigitAt(text, g)) {
        gaps.push(text.slice(q, g));
        p = g;
        continue;
      }
      i = q;
      break;
    }
    const count = gs.length / 2;
    if (digits.length < 13) continue;
    const size = (k: number) => (gs[2 * k + 1] as number) - (gs[2 * k] as number);
    const off = [0];
    for (let k = 0; k < count; k += 1) off.push((off[k] as number) + size(k));
    // A slash next to a short group is an expiry ("12/27"), not a separator inside a card.
    const expiryGap = (k: number) =>
      k + 1 < count && gaps[k]?.includes("/") === true && (size(k) <= 2 || size(k + 1) <= 2);
    const attempt = (s: number): number | undefined => {
      const first = digits.charCodeAt(off[s] as number) - 48;
      if (first === 0 || first === 7) return undefined; // no card issuer here starts with 0 or 7
      let emax = s;
      while (
        emax + 1 < count &&
        (off[emax + 2] as number) - (off[s] as number) <= 19 &&
        !expiryGap(emax) &&
        gaps[emax] === gaps[s]
      ) {
        emax += 1;
      }
      // The slice may not end on the month of an expiry that follows it ("… 12/27").
      if (expiryGap(emax)) emax -= 1;
      const g0 = size(s);
      const sep = gaps[s] ?? "";
      for (let e = emax; e >= s; e -= 1) {
        const total = (off[e + 1] as number) - (off[s] as number);
        if (total < 13) break;
        const grouped = g0 === 4 || g0 === 6 || g0 === 8 || g0 >= 12;
        let even = g0 <= 3 && !/[\n\r\v\f\u2028\u2029]/.test(sep);
        for (let k = s + 1; even && k <= e; k += 1) {
          if (k < e ? size(k) !== g0 : size(k) > g0) even = false;
        }
        if (!grouped && !even) continue;
        const pan = cardDigits(digits.slice(off[s], off[e + 1]));
        if (pan === undefined || !cardIssuerValid(pan)) continue;
        if (e > s && WEAK_SEP.test(sep)) {
          const from = gs[2 * s] as number;
          const to = gs[2 * e + 1] as number;
          const near = text.slice(Math.max(0, from - 40), from) + text.slice(to, to + 40);
          if (!CARD_WORD.test(near)) continue;
        }
        return e;
      }
      return undefined;
    };
    // Every group start is tried in turn: "Step 2: 4111 …" and "qty 2 4111 …" put short groups in
    // front of the card. After a card, the search goes on after it.
    let cur = 0;
    while (cur < count) {
      const e = attempt(cur);
      if (e === undefined) {
        cur += 1;
        continue;
      }
      const start = gs[2 * cur] as number;
      const end = gs[2 * e + 1] as number;
      if (!(skipIds && isIdToken(text, start, end))) found.push({ start, length: end - start });
      cur = e + 1;
    }
  }
  return found;
}

/** Card numbers in the strict reading (tool arguments, audit): single space, dot or dash, Luhn only. */
function strictCardMatches(text: string, skipIds: boolean): { start: number; length: number }[] {
  const found: { start: number; length: number }[] = [];
  for (const m of text.matchAll(CARD_CANDIDATE)) {
    const end = m.index + m[0].length;
    if (cardDigits(m[0]) !== undefined && !(skipIds && isIdToken(text, m.index, end))) {
      found.push({ start: m.index, length: m[0].length });
    }
  }
  return found;
}

export interface FindOptions {
  /**
   * The outbound reading (messages Psyche sends): cards may be split by newlines, pipes, slashes,
   * bullets or several spaces, and are found inside longer digit chains. The default, strict reading
   * is what the hard prohibitions and audit redaction use: there a false match blocks a file write.
   */
  outbound?: boolean;
  /**
   * `"skip"`: a card-length run inside an identifier-shaped token (a hex digest of 32+ characters, a
   * ULID, a canonical UUID) is not reported. Only the owner-facing redaction of logs and receipts
   * passes it, so a hash is not masked there. Blocking paths never do: the default is `"strict"`, which
   * reports every Luhn-valid card, so hex padding around a card cannot hide it.
   */
  idTokens?: "skip" | "strict";
}

export function findSensitive(text: string, options: FindOptions = {}): SensitiveMatch[] {
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
  for (const span of options.outbound === true
    ? cardMatches(text, options.idTokens === "skip")
    : strictCardMatches(text, options.idTokens === "skip")) {
    out.push({ kind: "card_number", index: span.start, length: span.length });
  }
  for (const m of text.matchAll(IBAN_CANDIDATE)) {
    // The candidate may run into a following word; take the longest prefix that validates.
    for (let end = m[0].length; end >= 15; end -= 1) {
      const head = m[0].slice(0, end);
      if (head.endsWith(" ")) continue;
      if (ibanValid(head) && ibanShaped(head)) {
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

/** Binary search: is any of the sorted `points` within `reach` of `at`, other than `at` itself? */
function hasNear(points: readonly number[], at: number, reach: number): number | undefined {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((points[mid] as number) < at - reach) lo = mid + 1;
    else hi = mid;
  }
  for (let k = lo; k < points.length && (points[k] as number) <= at + reach; k += 1) {
    if (points[k] !== at) return points[k];
  }
  return undefined;
}

function findIdentifiers(text: string, out: SensitiveMatch[]): void {
  const pushed = new Set<string>();
  const push = (kind: SensitiveKind, index: number, length: number) => {
    pushed.add(`${kind}:${index}`);
    out.push({ kind, index, length });
  };

  // US bank account: a labeled routing number (ABA checksum) next to a labeled account number. A
  // routing number alone is public and an account word alone names utility bills, so neither counts.
  const routing: number[] = [];
  for (const m of text.matchAll(ABA_CANDIDATE)) {
    if (!abaValid(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 28), m.index);
    const after = text.slice(m.index + 9, m.index + 9 + 24);
    if (ROUTING_BEFORE.test(before) || ROUTING_AFTER.test(after)) routing.push(m.index);
  }
  if (routing.length > 0) {
    for (const m of text.matchAll(ACCOUNT_LABELED)) {
      const at = groupSpan(m);
      const near = hasNear(routing, at, 150);
      if (near === undefined) continue;
      push("us_bank_account", at, (m[1] as string).length);
      if (!pushed.has(`us_bank_account:${near}`)) push("us_bank_account", near, 9);
    }
  }

  // A card's CVV and expiry, only next to a detected card (a lone "CVV 123" is not usable).
  const cards = out.filter((o) => o.kind === "card_number");
  if (cards.length > 0) {
    // Sorted, merged windows of 100 characters around each card, searched in log time.
    const windows: [number, number][] = [];
    for (const c of cards) {
      const lo = c.index - 100;
      const hi = c.index + c.length + 100;
      const last = windows[windows.length - 1];
      if (last !== undefined && lo <= last[1]) last[1] = Math.max(last[1], hi);
      else windows.push([lo, hi]);
    }
    const near = (index: number, length: number) => {
      let lo = 0;
      let hi = windows.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (((windows[mid] as [number, number])[1] as number) <= index) lo = mid + 1;
        else hi = mid;
      }
      const w = windows[lo];
      return w !== undefined && w[0] < index + length;
    };
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

  for (const m of text.matchAll(SSN_LABELED)) {
    const digits = (m[1] as string).replace(/\D/g, "");
    if (/^(?!000|666|9)\d{3}(?!00)\d{2}(?!0000)\d{4}$/.test(digits)) {
      push("us_ssn", groupSpan(m), (m[1] as string).length);
    }
  }
  for (const m of text.matchAll(PASSPORT)) {
    push("passport", groupSpan(m), (m[1] as string).length);
  }
  for (const m of text.matchAll(SIN_LABELED)) {
    if (sinValid(m[1] as string)) push("ca_sin", groupSpan(m), (m[1] as string).length);
  }
  for (const m of text.matchAll(NINO_LABEL)) {
    NINO_VALUE.lastIndex = m.index + m[0].length;
    const v = NINO_VALUE.exec(text);
    if (v !== null) push("uk_nino", v.index, v[0].length);
  }
  for (const m of text.matchAll(AADHAAR_LABELED)) {
    if (aadhaarValid(m[1] as string)) push("in_aadhaar", groupSpan(m), (m[1] as string).length);
  }
  for (const m of text.matchAll(OTP_AFTER)) {
    push("one_time_code", groupSpan(m), (m[1] as string).length);
  }
  for (const re of [YOUR_CODE, THE_CODE]) {
    for (const m of text.matchAll(re)) {
      if (NOT_A_LOGIN_CODE.test(m[1] as string)) continue;
      if (re === THE_CODE && !LOGIN_WORD.test(m[1] as string)) continue;
      push("one_time_code", groupSpan(m), (m[2] as string).length);
    }
  }
  for (const m of text.matchAll(OTP_USE)) {
    push("one_time_code", groupSpan(m), (m[1] as string).length);
  }
  for (const m of text.matchAll(OTP_BEFORE)) {
    push("one_time_code", m.index, (m[1] as string).length);
  }
}

// ---- the scan view: what a reader sees, with the encodings that hide digits undone ----------------

/** Digit value of a non-ASCII decimal digit: Unicode lays every set out as ten in a row from zero. */
function digitValue(cp: number): number {
  let zero = cp;
  while (cp - zero < 60 && /^\p{Nd}$/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
  return (cp - zero) % 10;
}

function foldChar(ch: string): string {
  let out = "";
  for (const c of ch.normalize("NFKC")) {
    const cp = c.codePointAt(0) as number;
    if (cp < 128) out += c;
    else if (/^[\p{Cf}\p{Mn}\p{Me}]$/u.test(c)) continue;
    else if (/^\p{Nd}$/u.test(c)) out += String(digitValue(cp));
    else out += c;
  }
  return out;
}

export interface ScanView {
  /** NFKC form, format and combining marks removed, every decimal digit written 0–9. */
  text: string;
  /** For each UTF-16 unit of `text`: where its source character starts and ends in the original. */
  start: number[];
  end: number[];
}

const ASCII_ONLY = /^\p{ASCII}*$/u;

export function scanView(text: string): ScanView {
  if (ASCII_ONLY.test(text)) return { text, start: [], end: [] };
  let out = "";
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) as number;
    const width = cp > 0xffff ? 2 : 1;
    const piece = cp < 128 ? text.charAt(i) : foldChar(text.slice(i, i + width));
    for (let k = 0; k < piece.length; k += 1) {
      start.push(i);
      end.push(i + width);
    }
    out += piece;
    i += width;
  }
  return { text: out, start, end };
}

/**
 * Matches on the scan view, so full-width and Arabic-Indic, Persian or Devanagari digits, zero-width
 * joiners and similar encodings are caught. Indices refer to the view's text.
 */
export function findSensitiveNormalized(text: string, options: FindOptions = {}): SensitiveMatch[] {
  return findSensitive(scanView(text).text, options);
}

/**
 * The same matches, with `index` and `length` in the original text (to cut exactly those spans). A
 * span runs on over characters that read as nothing (a keycap's U+FE0F U+20E3), so none is left.
 */
export function findSensitiveOriginal(text: string, options: FindOptions = {}): SensitiveMatch[] {
  const view = scanView(text);
  const matches = findSensitive(view.text, options);
  if (view.text === text) return matches;
  return matches.map((m) => {
    const from = view.start[m.index] as number;
    let to = view.end[m.index + m.length - 1] as number;
    while (to < text.length) {
      const cp = text.codePointAt(to) as number;
      if (cp < 128) break;
      const ch = String.fromCodePoint(cp);
      if (foldChar(ch) !== "") break;
      to += ch.length;
    }
    return { kind: m.kind, index: from, length: to - from };
  });
}

export function containsSensitive(text: string): boolean {
  return findSensitiveNormalized(text).length > 0;
}

export const REDACTED = "[redacted]";

/**
 * Replace every sensitive match with `[redacted:<kind>]`. Owner-facing by default: identifier-shaped
 * tokens are not masked (`idTokens: "skip"`). A caller whose output a model reads passes `{}`.
 */
export function redactSensitive(text: string, options: FindOptions = { idTokens: "skip" }): string {
  const matches = findSensitive(text, options);
  if (matches.length === 0) {
    // Encoded forms (full-width or Arabic-Indic digits, zero-width separators) redact the whole string.
    const hidden = findSensitiveNormalized(text, options)[0];
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
