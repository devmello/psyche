import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoSecrets,
  clearSecrets,
  findSecrets,
  registeredSecretCount,
  registerSecret,
  SecretLeakError,
} from "../src/index.ts";

const SECRET = "sk-test-0123456789abcdef";

describe("secret-leak checker", () => {
  afterEach(() => clearSecrets());

  it("finds raw, base64, base64url, URL-encoded and hex forms", () => {
    const value = "p@ss/word+with=chars?";
    registerSecret(value, "tricky");
    const b64 = Buffer.from(value).toString("base64");
    const text = [
      value,
      b64,
      Buffer.from(value).toString("base64url"),
      encodeURIComponent(value),
      Buffer.from(value).toString("hex"),
    ].join(" | ");
    const encodings = new Set(findSecrets(text).map((m) => m.encoding));
    expect(encodings).toEqual(new Set(["raw", "base64", "base64url", "url", "hex"]));
  });

  it("walks nested objects, arrays, keys and toJSON", () => {
    registerSecret(SECRET, "api-key");
    const matches = findSecrets({
      a: [{ b: `Bearer ${SECRET}` }],
      [SECRET]: 1,
      c: { toJSON: () => ({ hidden: SECRET }) },
    });
    expect(matches.map((m) => m.path).sort()).toEqual(["$.<key>", "$.a[0].b", "$.c.hidden"].sort());
  });

  it("finds base64 forms at any alignment, embedded in longer data (HTTP Basic)", () => {
    const pw = "correct-horse-battery-staple";
    registerSecret(pw, "pw");
    for (const prefix of ["", "a", "bob:", "alice:", "xy"]) {
      for (const suffix of ["", "X", "XY", ":tail"]) {
        const raw = Buffer.from(`${prefix}${pw}${suffix}`);
        for (const encoded of [raw.toString("base64"), raw.toString("base64url")]) {
          expect(
            findSecrets(`Authorization: Basic ${encoded}`).length,
            `${prefix}|${suffix}`,
          ).toBeGreaterThan(0);
        }
      }
    }
    expect(findSecrets(Buffer.from("bob:something-else-entirely").toString("base64"))).toEqual([]);
  });

  it("walks Error message, stack and cause, and Map / Set contents", () => {
    registerSecret(SECRET, "api-key");
    expect(findSecrets(new Error(`bad key ${SECRET}`)).length).toBeGreaterThan(0);
    expect(
      findSecrets(new Error("outer", { cause: new Error(SECRET) })).map((m) => m.path),
    ).toContain("$.cause.message");
    expect(findSecrets({ e: new AggregateError([new Error(SECRET)]) }).length).toBeGreaterThan(0);
    expect(findSecrets(new Map([["k", SECRET]])).length).toBeGreaterThan(0);
    expect(findSecrets(new Map([[SECRET, 1]])).length).toBeGreaterThan(0);
    expect(findSecrets(new Set([{ nested: SECRET }])).length).toBeGreaterThan(0);
  });

  it("assertNoSecrets throws with label and offset, never the value", () => {
    registerSecret(SECRET, "api-key");
    let caught: unknown;
    try {
      assertNoSecrets(`header: Authorization: Bearer ${SECRET}`, "tool result");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecretLeakError);
    const message = (caught as Error).message;
    expect(message).toContain("api-key");
    expect(message).toContain("tool result");
    expect(message).toContain("offset 30");
    expect(message).not.toContain(SECRET);
  });

  it("passes clean text and refuses too-short secrets", () => {
    registerSecret(SECRET);
    expect(() => assertNoSecrets({ text: "nothing to see", n: 4 })).not.toThrow();
    expect(() => registerSecret("abc")).toThrow(RangeError);
  });

  it("clearSecrets empties the registry", () => {
    registerSecret(SECRET);
    expect(registeredSecretCount()).toBe(1);
    clearSecrets();
    expect(findSecrets(SECRET)).toEqual([]);
  });
});
