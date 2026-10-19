import { assertNoSecrets, clearSecrets, registerSecret } from "@psyche/testing";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { base32Encode, encodingsOf, MASK, SecretRedactor } from "../src/index.ts";

afterEach(() => clearSecrets());

const rot13 = (s: string) =>
  s.replace(/[a-z]/gi, (c) => {
    const b = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
  });

/** Secrets: 8–48 characters, mostly token-like, sometimes any unicode. */
const secretArb = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9_\-+/=.]{8,48}$/),
  fc.string({ minLength: 8, maxLength: 32, unit: "grapheme" }).filter((s) => s.trim().length >= 8),
);

/** How the secret shows up in output: every form a hostile page or command could produce. */
const encodings: [string, (s: string) => string][] = [
  ["raw", (s) => s],
  ["url", (s) => encodeURIComponent(s)],
  ["form", (s) => encodeURIComponent(s).replace(/%20/g, "+")],
  ["json", (s) => JSON.stringify(s).slice(1, -1)],
  ["base64", (s) => Buffer.from(s).toString("base64")],
  ["base64 basic auth", (s) => Buffer.from(`user:${s}`).toString("base64")],
  ["base64url", (s) => Buffer.from(`x${s}`).toString("base64url")],
  ["hex", (s) => Buffer.from(s).toString("hex")],
  ["HEX", (s) => Buffer.from(s).toString("hex").toUpperCase()],
  ["base32", (s) => base32Encode(Buffer.from(s))],
  ["reversed", (s) => [...s].reverse().join("")],
  ["rot13", rot13],
];

/** Fuzzy forms (S23 design-18): only for secrets with at least 8 letters/digits. */
const fuzzy: [string, (s: string) => string][] = [
  ["spaced", (s) => [...s].join(" ")],
  ["upper", (s) => s.toUpperCase()],
  ["newlines", (s) => [...s].join("\n")],
  ["zero-width", (s) => [...s].join("​")],
  ["fullwidth", (s) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))],
  ["spaced reversed", (s) => [...s].reverse().join(" ")],
];

describe("SecretRedactor property tests", () => {
  it("no registered secret survives redact, in any encoding, anywhere in the text", () => {
    fc.assert(
      fc.property(
        fc.array(secretArb, { minLength: 1, maxLength: 4 }),
        fc.string({ maxLength: 40 }),
        fc.string({ maxLength: 40 }),
        fc.nat(encodings.length - 1),
        (secrets, before, after, enc) => {
          const r = new SecretRedactor();
          for (const s of secrets) r.add(s);
          const encode = (encodings[enc] ?? ["raw", (s: string) => s])[1];
          const text = `${before}${secrets.map((s) => encode(s)).join(before)}${after}`;
          const out = r.redact(text);
          for (const s of secrets) {
            if ([...s].length < 6) continue;
            for (const form of encodingsOf(s).filter((f) => f.length >= 6)) {
              expect(out.includes(form), `${encodings[enc]?.[0]} form survived`).toBe(false);
            }
          }
          expect(r.contains(out)).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("fuzzy forms of alphanumeric secrets are caught", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{8,32}$/),
        fc.nat(fuzzy.length - 1),
        fc.stringMatching(/^[ .,!?a-z]{0,20}$/),
        (secret, f, noise) => {
          const r = new SecretRedactor();
          r.add(secret);
          const encode = (fuzzy[f] ?? ["spaced", (s: string) => s])[1];
          const out = r.redact(`${noise}[${encode(secret)}]${noise}`);
          expect(out).toContain(MASK);
          expect(r.contains(out)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("leaves text without secrets alone", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z]{12,24}$/),
        fc.stringMatching(/^[a-z0-9 ]{0,80}$/),
        (secret, text) => {
          const r = new SecretRedactor();
          r.add(secret);
          expect(r.redact(text)).toBe(text);
        },
      ),
    );
  });

  it("agrees with the shared secret-leak checker", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]{10,40}$/),
        fc.string({ maxLength: 30 }),
        (secret, noise) => {
          clearSecrets();
          registerSecret(secret, "s");
          const r = new SecretRedactor();
          r.add(secret);
          const text = [
            secret,
            encodeURIComponent(secret),
            Buffer.from(secret).toString("base64"),
            Buffer.from(secret).toString("hex"),
          ].join(noise);
          assertNoSecrets(r.redact(text), "redact output");
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("SecretRedactor rules", () => {
  it("ignores values shorter than six characters", () => {
    const r = new SecretRedactor();
    expect(r.add("12345")).toBe(false);
    expect(r.redact("12345")).toBe("12345");
  });

  it("masks truncated echoes of long keys (S23 design-16)", () => {
    const key = "sk-test-0123456789abcdefghijKLMN";
    const r = new SecretRedactor();
    r.add(key);
    expect(r.redact(`invalid key ${key.slice(0, 12)}…${key.slice(-4)}`)).not.toContain(
      key.slice(0, 12),
    );
    expect(r.redact(`key ending ${key.slice(-12)}`)).not.toContain(key.slice(-12));
  });

  it("keeps values that left the vault after dropNonSticky (lock)", () => {
    const r = new SecretRedactor();
    r.add("never-left-vault-1");
    r.add("was-resolved-once-2");
    r.markSticky("was-resolved-once-2");
    r.dropNonSticky();
    expect(r.redact("never-left-vault-1 was-resolved-once-2")).toBe(`never-left-vault-1 ${MASK}`);
  });
});
