/**
 * Secret-leak checker: registered values (security §4.5–§4.7, §15.4 item 7).
 *
 * This module registers secret values and finds them (raw, base64, base64url, URL-encoded and
 * hex forms) in strings or arbitrary objects. `SecretSet` is an independent registry; the
 * module-level functions use a default one. Pattern detectors live in `secret-patterns.ts`, the
 * shared fixture registry in `secret-registry.ts`, model-visible capture and scanning in
 * `capture.ts`. Errors name the secret's label and offset, never the value.
 */

export type SecretEncoding = "raw" | "base64" | "base64url" | "url" | "hex";

export interface SecretMatch {
  label: string;
  encoding: SecretEncoding;
  /** Character offset inside the scanned string. */
  offset: number;
  /** JSON-ish path inside the scanned object (`$` for a plain string). */
  path: string;
}

interface Registered {
  label: string;
  forms: { encoding: SecretEncoding; text: string }[];
}

/** Values shorter than this are refused: they would match too much innocent text. */
export const MIN_SECRET_LENGTH = 6;

/**
 * Base64 fragments of `bytes` that appear in the encoding of any byte string containing it,
 * whatever precedes or follows (e.g. HTTP Basic `base64("user:" + password)`). For each of the
 * three alignments the secret can start at, the characters that mix in neighbouring bytes are
 * trimmed from both edges. Returned without padding, in the standard alphabet.
 */
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

const toBase64Url = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_");

function formsOf(value: string): Registered["forms"] {
  const bytes = Buffer.from(value, "utf8");
  const fragments = base64Fragments(bytes);
  const forms: Registered["forms"] = [
    { encoding: "raw", text: value },
    ...fragments.map((text) => ({ encoding: "base64" as const, text })),
    ...fragments.map((text) => ({ encoding: "base64url" as const, text: toBase64Url(text) })),
    { encoding: "url", text: encodeURIComponent(value) },
    { encoding: "hex", text: bytes.toString("hex") },
  ];
  // Drop duplicate texts (e.g. URL-encoding of a plain token equals the raw value).
  const seen = new Set<string>();
  return forms.filter((f) => {
    if (seen.has(f.text)) return false;
    seen.add(f.text);
    return true;
  });
}

/** An independent set of registered secrets. */
export class SecretSet {
  #entries = new Map<string, Registered>();

  /** Register a secret value so `find` looks for it. */
  add(value: string, label = "secret"): void {
    if (value.length < MIN_SECRET_LENGTH) {
      throw new RangeError(
        `registerSecret(${label}): values shorter than ${MIN_SECRET_LENGTH} chars are not tracked`,
      );
    }
    this.#entries.set(value, { label, forms: formsOf(value) });
  }

  delete(value: string): void {
    this.#entries.delete(value);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Every registered secret (in any tracked encoding) found in `input`. */
  find(input: unknown): SecretMatch[] {
    const out: SecretMatch[] = [];
    forEachString(input, (text, path) => {
      scanString(this.#entries, text, path, out);
    });
    return out;
  }
}

const defaultSet = new SecretSet();

/** Register a secret value so `findSecrets` / `assertNoSecrets` look for it. */
export function registerSecret(value: string, label = "secret"): void {
  defaultSet.add(value, label);
}

export function unregisterSecret(value: string): void {
  defaultSet.delete(value);
}

export function clearSecrets(): void {
  defaultSet.clear();
}

export function registeredSecretCount(): number {
  return defaultSet.size;
}

function scanString(
  entries: Map<string, Registered>,
  text: string,
  path: string,
  out: SecretMatch[],
): void {
  for (const entry of entries.values()) {
    for (const form of entry.forms) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(form.text, from);
        if (at < 0) break;
        out.push({ label: entry.label, encoding: form.encoding, offset: at, path });
        from = at + 1;
      }
    }
  }
}

/**
 * Calls `visit` for every string reachable from `input`: nested objects, arrays, object keys,
 * Map / Set entries, `toJSON` output, Error name / message / stack / cause, and Uint8Array
 * contents decoded as UTF-8. Paths are JSON-ish (`$` for a plain string).
 */
export function forEachString(input: unknown, visit: (text: string, path: string) => void): void {
  walk(input, "$", visit, new Set());
}

function walk(
  value: unknown,
  path: string,
  visit: (text: string, path: string) => void,
  seen: Set<object>,
): void {
  if (typeof value === "string") {
    visit(value, path);
    return;
  }
  if (value instanceof Uint8Array) {
    visit(Buffer.from(value).toString("utf8"), path);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  // Whatever an object serializes to is what reaches logs and transcripts.
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === "function") {
    walk((json as () => unknown).call(value), path, visit, seen);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      walk(v, `${path}[${i}]`, visit, seen);
    });
    return;
  }
  if (value instanceof Map) {
    let i = 0;
    for (const [k, v] of value) {
      walk(k, `${path}.<mapKey ${i}>`, visit, seen);
      walk(v, `${path}.<mapValue ${i}>`, visit, seen);
      i += 1;
    }
    return;
  }
  if (value instanceof Set) {
    let i = 0;
    for (const v of value) walk(v, `${path}.<set ${i++}>`, visit, seen);
    return;
  }
  if (value instanceof Error) {
    // name, message, stack and cause are non-enumerable but end up in logs.
    walk(value.name, `${path}.name`, visit, seen);
    walk(value.message, `${path}.message`, visit, seen);
    walk(value.stack, `${path}.stack`, visit, seen);
    walk(value.cause, `${path}.cause`, visit, seen);
    if (value instanceof AggregateError) walk(value.errors, `${path}.errors`, visit, seen);
  }
  for (const [k, v] of Object.entries(value)) {
    visit(k, `${path}.<key>`);
    walk(v, `${path}.${k}`, visit, seen);
  }
}

/** Every registered secret (in any tracked encoding) found in `input`. */
export function findSecrets(input: unknown): SecretMatch[] {
  return defaultSet.find(input);
}

export class SecretLeakError extends Error {
  readonly matches: SecretMatch[];
  constructor(matches: SecretMatch[], where?: string) {
    const lines = matches
      .slice(0, 10)
      .map((m) => `  - ${m.label} (${m.encoding}) at ${m.path} offset ${m.offset}`);
    super(
      `Secret leak${where === undefined ? "" : ` in ${where}`}: ${matches.length} match(es)\n${lines.join("\n")}`,
    );
    this.name = "SecretLeakError";
    this.matches = matches;
  }
}

/** Throws `SecretLeakError` (label + offset only, never the value) when any secret is present. */
export function assertNoSecrets(input: unknown, where?: string): void {
  const matches = findSecrets(input);
  if (matches.length > 0) throw new SecretLeakError(matches, where);
}
