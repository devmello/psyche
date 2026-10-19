import { base32Encode } from "./crypto.ts";

/** What redaction replaces a secret with (security §4.7). */
export const MASK = "•••";

export interface RedactorOptions {
  /** Shorter values are not tracked: they would mask ordinary text. Default 6. */
  minLength?: number;
  /** Fuzzy (normalized) matching only for values at least this long. Default 8. */
  fuzzyMinLength?: number;
}

interface Entry {
  forms: string[];
  fuzzy: string[];
  /** Kept after lock: values that left the vault in this process (S23 design-16). */
  sticky: boolean;
}

/** Characters dropped by the fuzzy pass, besides whitespace and format characters. */
const SEPARATORS = new Set([..."-_.,:;|/\\'\"`*·‧∙⋅+~^()[]{}<>"]);

function dropInFuzzy(ch: string): boolean {
  return /^[\s\p{Cf}\p{Z}]$/u.test(ch) || SEPARATORS.has(ch);
}

/** NFKC, lowercased, separators / whitespace / format characters removed, with an index map. */
function normalize(text: string): { norm: string; start: number[]; end: number[] } {
  let norm = "";
  const start: number[] = [];
  const end: number[] = [];
  let i = 0;
  for (const cp of text) {
    const n = cp.normalize("NFKC").toLowerCase();
    for (const ch of n) {
      if (dropInFuzzy(ch)) continue;
      for (let k = 0; k < ch.length; k += 1) {
        start.push(i);
        end.push(i + cp.length);
      }
      norm += ch;
    }
    i += cp.length;
  }
  return { norm, start, end };
}

function normalizedValue(value: string): string {
  return normalize(value).norm;
}

/** Base64 fragments of `bytes` at each of the three alignments it can sit at inside other data. */
export function base64Fragments(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const startChar = [0, 2, 3];
  for (let k = 0; k < 3; k += 1) {
    const padded = Buffer.concat([Buffer.alloc(k), Buffer.from(bytes)]);
    const full = padded.toString("base64").replace(/=+$/, "");
    const rem = padded.length % 3;
    const end = Math.floor(padded.length / 3) * 4 + (rem === 0 ? 0 : rem === 1 ? 1 : 2);
    const fragment = full.slice(startChar[k], end);
    if (fragment.length >= 4) out.push(fragment);
  }
  return [...new Set(out)];
}

const rot13 = (s: string) =>
  s.replace(/[a-z]/gi, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });

const reverse = (s: string) => [...s].reverse().join("");

const htmlEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Every exact form a value is looked for in (S23 design-15 / 16 / 18). */
export function encodingsOf(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const b64 = base64Fragments(bytes);
  const hex = bytes.toString("hex");
  const b32 = base32Encode(bytes);
  // design-18: `location.hash = btoa(reversed value)`.
  const b64Reversed = base64Fragments(Buffer.from(reverse(value), "utf8"));
  const forms = [
    value,
    encodeURIComponent(value),
    encodeURIComponent(value).replace(/%20/g, "+"),
    JSON.stringify(value).slice(1, -1),
    htmlEscape(value),
    ...b64,
    ...b64.map((f) => f.replace(/\+/g, "-").replace(/\//g, "_")),
    hex,
    hex.toUpperCase(),
    b32,
    b32.toLowerCase(),
    reverse(value),
    rot13(value),
    ...b64Reversed,
    ...b64Reversed.map((f) => f.replace(/\+/g, "-").replace(/\//g, "_")),
  ];
  // Long keys: providers echo truncated keys ("invalid key sk-…k3Xz"); mask a long prefix and the tail.
  if ([...value].length >= 20) forms.push(value.slice(0, 12), value.slice(-8));
  return [...new Set(forms.filter((f) => f.length > 0))];
}

/**
 * Registry of secret values and the masker every output path uses (security §4.7): tool
 * results, snapshots, `read_text`, transcripts, logs, receipts, audit data. Exact forms first,
 * then a fuzzy pass over normalized text (NFKC, case-folded, whitespace / separators / format
 * characters removed, also reversed), so `h u n t e r 2`, `HUNTER2` or a per-character span
 * layout is caught. Masking is a fallback: executors still keep values out of those paths.
 */
export class SecretRedactor {
  readonly #entries = new Map<string, Entry>();
  readonly #min: number;
  readonly #fuzzyMin: number;

  constructor(options: RedactorOptions = {}) {
    this.#min = options.minLength ?? 6;
    this.#fuzzyMin = options.fuzzyMinLength ?? 8;
  }

  /** Track `value`. Values shorter than `minLength` are ignored (returns false). */
  add(value: string, options: { sticky?: boolean } = {}): boolean {
    if ([...value].length < this.#min) return false;
    const existing = this.#entries.get(value);
    if (existing !== undefined) {
      existing.sticky ||= options.sticky === true;
      return true;
    }
    const norm = normalizedValue(value);
    const fuzzy = norm.length >= this.#fuzzyMin ? [...new Set([norm, reverse(norm)])] : [];
    this.#entries.set(value, {
      forms: encodingsOf(value)
        .filter((f) => f.length >= this.#min)
        .sort((a, b) => b.length - a.length),
      fuzzy,
      sticky: options.sticky === true,
    });
    return true;
  }

  /** Make an already-tracked value survive `dropNonSticky` (it left the vault). */
  markSticky(value: string): void {
    const e = this.#entries.get(value);
    if (e !== undefined) e.sticky = true;
    else this.add(value, { sticky: true });
  }

  remove(value: string): void {
    this.#entries.delete(value);
  }

  /** On lock: forget values that never left the vault; keep the ones that did. */
  dropNonSticky(): void {
    for (const [value, e] of this.#entries) if (!e.sticky) this.#entries.delete(value);
  }

  get size(): number {
    return this.#entries.size;
  }

  #spans(text: string): [number, number][] {
    const spans: [number, number][] = [];
    for (const e of this.#entries.values()) {
      for (const form of e.forms) {
        let from = 0;
        for (;;) {
          const at = text.indexOf(form, from);
          if (at < 0) break;
          spans.push([at, at + form.length]);
          from = at + 1;
        }
      }
    }
    let normalized: ReturnType<typeof normalize> | undefined;
    for (const e of this.#entries.values()) {
      if (e.fuzzy.length === 0) continue;
      normalized ??= normalize(text);
      const { norm, start, end } = normalized;
      for (const form of e.fuzzy) {
        let from = 0;
        for (;;) {
          const at = norm.indexOf(form, from);
          if (at < 0) break;
          spans.push([start[at] ?? 0, end[at + form.length - 1] ?? text.length]);
          from = at + 1;
        }
      }
    }
    return spans;
  }

  /** True when `text` holds any tracked value in any tracked form. */
  contains(text: string): boolean {
    return this.#spans(text).length > 0;
  }

  /** Replace every tracked value (all forms) with `•••`, until nothing matches. */
  redact(text: string): string {
    let out = text;
    for (let round = 0; round < 8; round += 1) {
      const spans = this.#spans(out).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      if (spans.length === 0) return out;
      const merged: [number, number][] = [];
      for (const [s, e] of spans) {
        const last = merged[merged.length - 1];
        if (last !== undefined && s <= last[1]) last[1] = Math.max(last[1], e);
        else merged.push([s, e]);
      }
      let next = "";
      let pos = 0;
      for (const [s, e] of merged) {
        next += out.slice(pos, s) + MASK;
        pos = e;
      }
      out = next + out.slice(pos);
    }
    // Pathological input: give up on partial masking rather than return a possible leak.
    return this.#spans(out).length === 0 ? out : MASK;
  }
}
