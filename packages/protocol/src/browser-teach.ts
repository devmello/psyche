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
  /** The field was a password field at some point (focus or key), whatever its type is now. */
  wasPassword?: boolean;
}

/**
 * Words that mark a field as sensitive. They are plain regex sources so the recorder's page
 * script (which runs in the page's isolated world and cannot import anything) can embed the same
 * list. Matched case-insensitively against the field's name, id, label and placeholder.
 */
export const TEACH_SENSITIVE_WORDS: readonly { reason: TeachSensitiveReason; source: string }[] = [
  {
    reason: "password",
    // English and the languages Psyche ships in; `pass` and `pw` are the short forms sites use.
    source:
      "pass(?:word|code|phrase)|passwd|\\bpwd\\b|\\bpass\\b|\\bpw\\b|contrase\u00f1a|\\bclave\\b|mot[- ]?de[- ]?passe|passwort|kennwort|\\bsenha\\b|\\bparola\\b|\\bpassord\\b|\u043f\u0430\u0440\u043e\u043b\u044c|\u5bc6\u7801|\u5bc6\u78bc|\u30d1\u30b9\u30ef\u30fc\u30c9|\ube44\ubc00\ubc88\ud638|\u0e23\u0e2b\u0e31\u0e2a\u0e1c\u0e48\u0e32\u0e19|\u092a\u093e\u0938\u0935\u0930\u094d\u0921|\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631",
  },
  {
    reason: "one_time_code",
    source:
      "\\b(?:otp|2fa|mfa|totp|one[- ]?time|verification[- ]code|security[- ]code|auth(?:entication)?[- ]code|sms[- ]code)\\b|(?:recovery|backup|reset)[- ]?(?:code|key)s?\\b",
  },
  {
    reason: "payment",
    source:
      "card[- _]?(?:number|no|num)|\\bcc[-_ ]?(?:num|number|exp|csc|cvc|cvv)|\\bcv[vc]2?\\b|\\bcsc\\b|expir(?:y|ation)|\\biban\\b|routing[- ]number|account[- ]number|sort[- ]code|\\bswift\\b",
  },
  {
    reason: "identity",
    source:
      "\\bssn\\b|social[- ]security|passport|national[- ]id|tax[- ]id|\\btin\\b|driver'?s?[- ]licen[cs]e",
  },
  {
    reason: "secret",
    source:
      "\\bsecret\\b|api[- ]?key|(?:access|auth)[- ]token|private[- ]key|\\bpin\\b|seed[- ]?phrase|mnemonic|recovery[- ]phrase|secret[- ]recovery",
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
  if (type === "password" || f.wasPassword === true) return "password";
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
      .map((seg) => {
        if (/^[A-Za-z0-9_-]{24,}$/.test(seg)) return "*";
        return redactTeachText(seg);
      })
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
 * The accessibility roles a recording keeps. The role comes from the page (`role="..."`), so it is
 * mapped onto this list and anything else becomes `generic`: a page cannot put text of its own in
 * a role.
 */
export const TEACH_ROLES: ReadonlySet<string> = new Set([
  "alert",
  "article",
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "combobox",
  "dialog",
  "document",
  "generic",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "link",
  "list",
  "listbox",
  "listitem",
  "main",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "navigation",
  "option",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "slider",
  "spinbutton",
  "status",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "textbox",
  "toolbar",
  "tooltip",
  "tree",
  "treeitem",
]);

export function teachRole(role: string | undefined): string {
  const r = (role ?? "").trim().toLowerCase();
  return TEACH_ROLES.has(r) ? r : "generic";
}

/**
 * Digits, emails and tokens in page text a recording keeps (names, selectors, path segments): a
 * card number, an ID number, an address or a JWT in an element name is replaced, not stored.
 */
export function redactTeachText(text: string): string {
  let out = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "<token>");
  out = out.replace(/\b(?:sk|pk|rk|ghp|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, "<token>");
  out = out.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<token>");
  out = out.replace(/(?:\d[ -]?){13,19}/g, (m) =>
    classifyTeachValue(m) === null ? m : "<number>",
  );
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "<number>");
  out = out.replace(/\d{6,}/g, "<number>");
  return out;
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
    if (s.role !== undefined) out.role = teachRole(s.role);
    if (s.name !== undefined) out.name = redactTeachText(teachText(s.name, 200));
    if (s.selector !== undefined) out.selector = redactTeachText(teachText(s.selector, 300));
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
