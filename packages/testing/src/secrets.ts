/**
 * Secret-leak checker (skeleton).
 *
 * TODO(S18): complete this module — a registry of fake credentials / cards / tokens shared by
 * all tests (the secret corpus), card-number (Luhn) and government-id pattern detection,
 * placeholder-resolution leak checks, a Vitest reporter/plugin that scans every model-visible
 * string captured in tests (prompts, tool results, transcripts, logs), the `pnpm check:secrets`
 * CLI, and CI wiring. See prompts/s18-security-test-harness.md and security §4.5–§4.7.
 *
 * What exists now: register secret values, find them (raw, base64, base64url, URL-encoded and
 * hex forms) in strings or arbitrary objects, and assert none are present. Errors name the
 * secret's label and offset, never the value.
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

const registry = new Map<string, Registered>();

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

/** Register a secret value so `findSecrets` / `assertNoSecrets` look for it. */
export function registerSecret(value: string, label = "secret"): void {
  if (value.length < MIN_SECRET_LENGTH) {
    throw new RangeError(
      `registerSecret(${label}): values shorter than ${MIN_SECRET_LENGTH} chars are not tracked`,
    );
  }
  registry.set(value, { label, forms: formsOf(value) });
}

export function unregisterSecret(value: string): void {
  registry.delete(value);
}

export function clearSecrets(): void {
  registry.clear();
}

export function registeredSecretCount(): number {
  return registry.size;
}

function scanString(text: string, path: string, out: SecretMatch[]): void {
  for (const entry of registry.values()) {
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

function walk(value: unknown, path: string, out: SecretMatch[], seen: Set<object>): void {
  if (typeof value === "string") {
    scanString(value, path, out);
    return;
  }
  if (value instanceof Uint8Array) {
    scanString(Buffer.from(value).toString("utf8"), path, out);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  // Whatever an object serializes to is what reaches logs and transcripts.
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === "function") {
    walk((json as () => unknown).call(value), path, out, seen);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      walk(v, `${path}[${i}]`, out, seen);
    });
    return;
  }
  if (value instanceof Map) {
    let i = 0;
    for (const [k, v] of value) {
      walk(k, `${path}.<mapKey ${i}>`, out, seen);
      walk(v, `${path}.<mapValue ${i}>`, out, seen);
      i += 1;
    }
    return;
  }
  if (value instanceof Set) {
    let i = 0;
    for (const v of value) walk(v, `${path}.<set ${i++}>`, out, seen);
    return;
  }
  if (value instanceof Error) {
    // name, message, stack and cause are non-enumerable but end up in logs.
    walk(value.name, `${path}.name`, out, seen);
    walk(value.message, `${path}.message`, out, seen);
    walk(value.stack, `${path}.stack`, out, seen);
    walk(value.cause, `${path}.cause`, out, seen);
    if (value instanceof AggregateError) walk(value.errors, `${path}.errors`, out, seen);
  }
  for (const [k, v] of Object.entries(value)) {
    scanString(k, `${path}.<key>`, out);
    walk(v, `${path}.${k}`, out, seen);
  }
}

/** Every registered secret (in any tracked encoding) found in `input`. */
export function findSecrets(input: unknown): SecretMatch[] {
  const out: SecretMatch[] = [];
  walk(input, "$", out, new Set());
  return out;
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
