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

function formsOf(value: string): Registered["forms"] {
  const bytes = Buffer.from(value, "utf8");
  const forms: Registered["forms"] = [
    { encoding: "raw", text: value },
    { encoding: "base64", text: bytes.toString("base64").replace(/=+$/, "") },
    { encoding: "base64url", text: bytes.toString("base64url") },
    { encoding: "url", text: encodeURIComponent(value) },
    { encoding: "hex", text: bytes.toString("hex") },
  ];
  // Drop encodings identical to the raw value (e.g. URL-encoding of a plain token).
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
