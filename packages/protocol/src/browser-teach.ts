import type { BrowserTeachStep } from "./methods/skills.ts";

/**
 * Teach by showing, browser phase (docs/design/teach-by-showing-2026.md): the rules that decide
 * what a recording may keep, shared by the recorder in the desktop app, the Gateway handler that
 * turns a recording into a skill draft and the review screen. They are pure and have no
 * dependencies so every layer applies the same ones.
 *
 * What is never kept, whatever the owner clicks: the value typed into a password, payment,
 * one-time-code, identity-number or secret field (decided by the field's type, autocomplete hint
 * and words, and again by what the value looks like), cookies, storage and session contents
 * (the recorder never reads them), and query strings and opaque path segments in URLs.
 */

/** Why a field counts as sensitive. */
export type TeachSensitiveReason = "password" | "payment" | "one_time_code" | "identity" | "secret";

/** What the page tells the recorder about a field; every text is the page's own (untrusted). */
export interface TeachFieldFacts {
  tag?: string;
  /** `input.type`, lowercased by the caller or not. */
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  /** The accessible name (label, aria-label, placeholder). */
  label?: string;
  placeholder?: string;
  inputmode?: string;
}

/**
 * Words that mark a field as sensitive. They are plain regex sources so the recorder's page
 * script (which runs in the page's isolated world and cannot import anything) can embed the same
 * list. Matched case-insensitively against the field's name, id, label and placeholder.
 */
export const TEACH_SENSITIVE_WORDS: readonly { reason: TeachSensitiveReason; source: string }[] = [
  { reason: "password", source: "pass(?:word|code|phrase)|passwd|\\bpwd\\b" },
  {
    reason: "one_time_code",
    source:
      "\\b(?:otp|2fa|mfa|totp|one[- ]?time|verification[- ]code|security[- ]code|auth(?:entication)?[- ]code|sms[- ]code)\\b",
  },
  {
    reason: "payment",
    source:
      "card[- _]?(?:number|no|num)|\\bcc[-_ ]?(?:num|number|exp|csc|cvc|cvv)|\\bcvv\\b|\\bcvc\\b|\\bcsc\\b|expir(?:y|ation)|\\biban\\b|routing[- ]number|account[- ]number|sort[- ]code|\\bswift\\b",
  },
  {
    reason: "identity",
    source:
      "\\bssn\\b|social[- ]security|passport|national[- ]id|tax[- ]id|\\btin\\b|driver'?s?[- ]licen[cs]e",
  },
  {
    reason: "secret",
    source: "\\bsecret\\b|api[- ]?key|(?:access|auth)[- ]token|private[- ]key|\\bpin\\b",
  },
];

/** `autocomplete` tokens that are sensitive by themselves. */
export const TEACH_SENSITIVE_AUTOCOMPLETE: readonly {
  reason: TeachSensitiveReason;
  token: string;
}[] = [
  { reason: "password", token: "current-password" },
  { reason: "password", token: "new-password" },
  { reason: "one_time_code", token: "one-time-code" },
];

const WORDS = TEACH_SENSITIVE_WORDS.map((w) => ({
  reason: w.reason,
  re: new RegExp(w.source, "i"),
}));

/** The reason a field is sensitive, or `null`. Decided from the field alone, before any value. */
export function classifyTeachField(f: TeachFieldFacts): TeachSensitiveReason | null {
  const type = (f.type ?? "").toLowerCase();
  if (type === "password") return "password";
  const tokens = (f.autocomplete ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (t.startsWith("cc-")) return "payment";
    for (const rule of TEACH_SENSITIVE_AUTOCOMPLETE) if (t === rule.token) return rule.reason;
  }
  const text = [f.name, f.id, f.label, f.placeholder]
    .filter((x) => typeof x === "string")
    .join(" ");
  if (text !== "") for (const w of WORDS) if (w.re.test(text)) return w.reason;
  return null;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** A value that is a secret whatever field it was typed into: a card number, an ID number, a token. */
export function classifyTeachValue(value: string): TeachSensitiveReason | null {
  for (const m of value.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "payment";
  }
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(value)) return "identity";
  if (/^[A-Za-z0-9_-]{32,}$/.test(value.trim())) return "secret";
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(value)) return "secret";
  if (/\b(?:sk|pk|rk|ghp|xox[abp])[-_][A-Za-z0-9_-]{16,}/.test(value)) return "secret";
  return null;
}

/**
 * A page address as a recording keeps it: origin and path only. Query strings and fragments carry
 * tokens, and a long opaque path segment (a reset link, an id) is replaced by `*`.
 */
export function teachUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const path = u.pathname
      .split("/")
      .map((seg) => (/^[A-Za-z0-9_-]{24,}$/.test(seg) ? "*" : seg))
      .join("/");
    return `${u.origin}${path}`.slice(0, 2048);
  } catch {
    return "";
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: flattening to one line is the point
const LINE_BREAKS = /[\u0000-\u001f\u007f\u2028\u2029]+/g;

/** One line of page text, as a recording keeps it: no control characters, capped. */
export function teachText(text: string, max = 120): string {
  const flat = text.replace(LINE_BREAKS, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * What may leave the review screen for the Gateway. A value survives only on a `type` or `select`
 * step the owner chose to keep, that is not sensitive and does not look like a secret, and that is
 * not an input (an input's value is asked for at run time). Everything else is cleaned again:
 * flags that contradict each other are resolved in favour of the stricter reading, and a step
 * whose field looks sensitive loses its value even if the page script missed it.
 */
export function sanitizeTeachSteps(steps: readonly BrowserTeachStep[]): BrowserTeachStep[] {
  return steps.map((s) => {
    const out: BrowserTeachStep = { id: s.id, kind: s.kind };
    if (s.url !== undefined) out.url = teachUrl(s.url);
    if (s.role !== undefined) out.role = teachText(s.role, 64);
    if (s.name !== undefined) out.name = teachText(s.name, 200);
    if (s.selector !== undefined) out.selector = teachText(s.selector, 300);
    if (s.key !== undefined) out.key = teachText(s.key, 40);
    const typed = s.kind === "type" || s.kind === "select";
    const sensitive =
      s.sensitive === true ||
      (typed &&
        classifyTeachField({
          ...(s.role === undefined ? {} : { type: s.role === "password" ? "password" : "" }),
          ...(s.name === undefined ? {} : { label: s.name }),
        }) !== null) ||
      (s.value !== undefined && classifyTeachValue(s.value) !== null);
    if (sensitive && typed) out.sensitive = true;
    if (typed && !sensitive && s.input !== undefined) {
      out.input = { name: s.input.name };
      if (s.input.description !== undefined)
        out.input.description = teachText(s.input.description, 200);
    }
    if (
      typed &&
      !sensitive &&
      s.input === undefined &&
      s.keepValue === true &&
      s.value !== undefined
    ) {
      out.keepValue = true;
      out.value = s.value.slice(0, 500);
    }
    return out;
  });
}

/** Problems that stop a Save: an empty list means the steps can become a skill. */
export function teachStepIssues(steps: readonly BrowserTeachStep[]): string[] {
  const issues: string[] = [];
  const names = new Set<string>();
  steps.forEach((s, i) => {
    const at = `step ${i + 1}`;
    if (s.kind === "navigate" && (s.url === undefined || s.url === ""))
      issues.push(`${at}: a navigation needs an http(s) address`);
    if (
      (s.kind === "click" || s.kind === "type" || s.kind === "select") &&
      s.name === undefined &&
      s.selector === undefined
    )
      issues.push(`${at}: it needs a name or a selector`);
    if (s.kind === "press" && (s.key === undefined || s.key === ""))
      issues.push(`${at}: a key press needs a key`);
    if (
      s.sensitive === true &&
      (s.value !== undefined || s.keepValue === true || s.input !== undefined)
    )
      issues.push(`${at}: a sensitive field keeps no value and cannot be an input`);
    if (s.keepValue === true && s.input !== undefined)
      issues.push(`${at}: a step is either a kept value or an input`);
    if (s.value !== undefined && s.keepValue !== true)
      issues.push(`${at}: a value is only kept when the owner chose to`);
    if (s.input !== undefined) {
      if (names.has(s.input.name)) issues.push(`${at}: the input ${s.input.name} is used twice`);
      names.add(s.input.name);
    }
  });
  return issues;
}
