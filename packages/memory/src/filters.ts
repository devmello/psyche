/**
 * Content filters for memory writes (security §8 "Filters"; shared rules: no secret in
 * model-visible text, no card numbers stored). Everything in the workspace is model-visible, so
 * credentials and card numbers are refused on every write. Government identifiers, financial
 * account numbers and health details are refused by the flush and dreaming jobs (and imports)
 * unless the owner enables sensitive topics. Patterns are deliberately conservative: a false
 * positive costs one skipped memory, a false negative leaks a secret into every future prompt.
 */

export type SensitiveKind = "secret" | "card" | "government_id" | "financial_account" | "health";

/** Kinds refused on every write, whoever writes. */
export const ALWAYS_REFUSED: ReadonlySet<SensitiveKind> = new Set(["secret", "card"]);

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, // OpenAI-style
  /\bgh[pousr]_[A-Za-z0-9]{36,}/, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/, // Slack
  /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}\b/, // Telegram bot
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@"'<>]+:[^/\s@"'<>]{3,}@[A-Za-z0-9.-]+/i, // credentials in a URL
  /\b(?:password|passwd|passcode|api[ _-]?key|secret|token|pin)\b\s*(?:is:?|=|:)\s*(?=\S*\d)\S{4,}/i,
];

const GOVERNMENT_ID: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN
  /\b(?:ssn|social security(?: number)?|passport(?: number| no\.?)?|driver'?s? licen[cs]e(?: number)?|national id|tax id|itin)\b\s*(?:is|=|:|#)?\s*[A-Z0-9-]{5,}/i,
];

const FINANCIAL_ACCOUNT: RegExp[] = [
  /\b(?:account|acct|routing|aba|iban|sort code)\s*(?:number|no\.?|#)?\s*(?:is|=|:)?\s*[A-Z0-9 -]{6,34}\d/i,
];

const HEALTH =
  /\b(?:diagnos(?:is|ed)|prescri(?:bed|ption)|medication|dosage|therapist|therapy|psychiatri\w*|hiv|cancer|chemo\w*|diabet\w*|depress(?:ion|ed)|anxiety disorder|bipolar|adhd|pregnan\w*|miscarriage|std|sti|blood test|biopsy|surgery)\b/i;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
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

function hasCardNumber(text: string): boolean {
  for (const m of text.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

function ibanValid(candidate: string): boolean {
  const s = candidate.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

function hasIban(text: string): boolean {
  for (const m of text.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g)) {
    if (ibanValid(m[0])) return true;
  }
  return false;
}

/** Every sensitive kind found in `text` (empty when clean). */
export function detectSensitive(text: string): SensitiveKind[] {
  const found = new Set<SensitiveKind>();
  if (SECRET_PATTERNS.some((p) => p.test(text))) found.add("secret");
  if (hasCardNumber(text)) found.add("card");
  if (GOVERNMENT_ID.some((p) => p.test(text))) found.add("government_id");
  if (hasIban(text) || FINANCIAL_ACCOUNT.some((p) => p.test(text))) found.add("financial_account");
  if (HEALTH.test(text)) found.add("health");
  return [...found];
}

/** Kinds that block a write: always secrets and cards, the rest unless sensitive is allowed. */
export function blockingKinds(text: string, allowSensitive: boolean): SensitiveKind[] {
  return detectSensitive(text).filter((k) => ALWAYS_REFUSED.has(k) || !allowSensitive);
}

const INSTRUCTION_LIKE: RegExp[] = [
  /\bignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions|messages|rules)\b/i,
  /\b(?:system prompt|developer message|jailbreak)\b/i,
  /\byou (?:must|should|will) (?:always|now|immediately|never)\b/i,
  /\b(?:from now on|whenever you|when you see)\b/i,
  /\b(?:send|forward|transfer|wire|email|upload|post)\b.{0,40}\b(?:to|at)\b.{0,40}(?:@|https?:\/\/|\$\d)/i,
  /\b(?:run|execute|curl|wget|eval)\b.{0,30}(?:`|\$\(|https?:\/\/|\bsh\b|\bbash\b)/i,
  /\bdo not (?:tell|inform|mention to) (?:the )?(?:user|owner)\b/i,
  /<\/?(?:system|instructions?|tool|assistant)>/i,
];

/**
 * Text that reads like an instruction to the agent (security §8 "Import validation"). Flagged
 * for the owner's review; never executed either way.
 */
export function looksLikeInstruction(text: string): boolean {
  return INSTRUCTION_LIKE.some((p) => p.test(text));
}
