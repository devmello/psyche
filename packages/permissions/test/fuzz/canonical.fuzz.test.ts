import { canonicalJSON, hashCanonical } from "@psyche/audit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bindingFor } from "../../src/index.ts";
import { FUZZ } from "./config.ts";

/**
 * Binding-hash canonicalization (security §3.5, S23 design-13): two different argument sets never
 * share a hash, and one argument set never splits into two hashes (key order, number spelling).
 */

const opts = { seed: FUZZ.seed, numRuns: FUZZ.numRuns };

// Strings that stress Unicode: NFC / NFD pairs, combining marks, astral planes, controls.
const tricky = fc.constantFrom("café", "café", "Å", "Å", "Å", "😀", "\u0000", "‮", "﻿", "", " ");
const str = fc.oneof(fc.string({ unit: "binary", maxLength: 8 }), tricky);
const num = fc.oneof(
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Object.is(n, -0)),
  fc.constantFrom(0, 1, 1e21, 1e-7, 0.1, 2 ** 53, -(2 ** 53)),
);

type J = null | boolean | number | string | J[] | { [k: string]: J };
const { json } = fc.letrec<{ json: J }>((tie) => ({
  json: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    num,
    str,
    fc.array(tie("json"), { maxLength: 4 }),
    fc.dictionary(str, tie("json"), { maxKeys: 4 }),
  ),
}));

/** Structural equality: objects are unordered, strings compare code unit by code unit. */
function same(a: J, b: J): boolean {
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object")
    return Object.is(a, b);
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => same(x, b[i] as J))
    );
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same(a[k] as J, b[k] as J));
}

/** The same value with every object's keys in another order. */
function reorder(v: J, seed: number): J {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x, i) => reorder(x, seed + i));
  const keys = Object.keys(v);
  const rotated = keys.map((_, i) => keys[(i + seed) % keys.length] as string).reverse();
  const out: { [k: string]: J } = Object.create(null);
  for (const k of rotated) out[k] = reorder(v[k] as J, seed + 1);
  return out;
}

describe("fuzz: canonical JSON", () => {
  it("never splits one value: any key order gives the same bytes", () => {
    fc.assert(
      fc.property(json, fc.nat(50), (v, seed) => {
        expect(canonicalJSON(reorder(v, seed))).toBe(canonicalJSON(v));
      }),
      opts,
    );
  });

  it("never merges two values: equal bytes iff structurally equal", () => {
    fc.assert(
      fc.property(json, json, (a, b) => {
        expect(hashCanonical(a) === hashCanonical(b)).toBe(same(a, b));
      }),
      opts,
    );
  });

  it("a one-place edit always changes the hash", () => {
    const edit = (v: J): J[] => {
      if (typeof v === "string")
        return [`${v}x`, v.normalize("NFD"), v.normalize("NFC")].filter((x) => x !== v);
      if (typeof v === "number")
        return [Number.isSafeInteger(v) ? v + 1 : v === 0 ? 1 : -v, String(v)];
      if (typeof v === "boolean") return [!v];
      if (v === null) return [0, "", false];
      if (Array.isArray(v))
        return [[...v, null], v.length > 1 ? [...v].reverse() : [v]].filter((x) => !same(x, v));
      return [{ ...v, __fuzz_added__: null }];
    };
    fc.assert(
      fc.property(json, (v) => {
        for (const e of edit(v)) expect(hashCanonical(e)).not.toBe(hashCanonical(v));
      }),
      opts,
    );
  });
});

describe("fuzz: binding hashes", () => {
  const word = fc.oneof(
    fc.string({ unit: "binary", minLength: 1, maxLength: 6 }),
    tricky.filter((s) => s.length > 0),
  );
  const argv = fc.array(
    word.filter((s) => !s.includes("\0")),
    { minLength: 1, maxLength: 5 },
  );
  const envName = fc
    .stringMatching(/^[A-Z_][A-Z0-9_]{0,6}$/)
    .filter((n) => !/^(LD_|DYLD_|GIT_|PATH$|IFS$|ENV$)/.test(n));
  const env = fc.dictionary(envName, fc.string({ maxLength: 6 }), { maxKeys: 4 });
  const exec = (a: string[], e: Record<string, string>) =>
    bindingFor("exec", { argv: a, cwd: "/workspace", executable: "/usr/bin/tool", env: e });

  it("exec: argv order and content are bound exactly; env order is not", () => {
    fc.assert(
      fc.property(argv, argv, env, (a, b, e) => {
        const reordered = Object.fromEntries(Object.entries(e).reverse());
        expect(exec(a, reordered).bindingHash).toBe(exec(a, e).bindingHash);
        const equal = a.length === b.length && a.every((x, i) => x === b[i]);
        expect(exec(a, e).bindingHash === exec(b, e).bindingHash).toBe(equal);
      }),
      opts,
    );
  });

  const local = fc.stringMatching(/^[a-z0-9]{1,6}$/);
  const domain = fc.constantFrom("example.org", "example.com", "evil.test", "bücher.example");
  const address = fc.tuple(local, domain).map(([l, d]) => `${l}@${d}`);
  const mail = (to: string[]) =>
    bindingFor("send_email", {
      account: "gmail:owner@example.com",
      to,
      subject: "s",
      bodySha256: `sha256:${"a".repeat(64)}`,
    });

  it("email: recipient order, case and duplicates never split; a different set never merges", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(address, { minLength: 1, maxLength: 4 }),
        fc.uniqueArray(address, { minLength: 1, maxLength: 4 }),
        (a, b) => {
          const variant = [...a]
            .reverse()
            .map((x) => x.toUpperCase())
            .concat(a[0] ?? []);
          expect(mail(variant).bindingHash).toBe(mail(a).bindingHash);
          expect(mail(variant).grantKey).toBe(mail(a).grantKey);
          const setA = new Set(a.map((x) => mail([x]).grantFields.recipients?.toString()));
          const setB = new Set(b.map((x) => mail([x]).grantFields.recipients?.toString()));
          const sameSet = setA.size === setB.size && [...setA].every((x) => setB.has(x));
          expect(mail(a).grantKey === mail(b).grantKey).toBe(sameSet);
        },
      ),
      opts,
    );
  });

  it("purchase: amounts must be safe integers; every other number spelling throws", () => {
    const base = {
      merchant: "shop.example",
      currency: "EUR",
      lineItems: [{ name: "x", qty: 1, unitPriceMinor: 100 }],
      paymentSourceId: "pm_1",
    };
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double(),
          fc.integer({ min: 1 }),
          fc.constantFrom(-0, 0.5, 2 ** 53, Number.NaN),
        ),
        (amountMinor) => {
          const ok = Number.isSafeInteger(amountMinor) && amountMinor >= 1;
          const run = () => bindingFor("purchase", { ...base, amountMinor });
          if (ok) expect(run().bindingHash).toMatch(/^sha256:/);
          else expect(run).toThrow();
        },
      ),
      opts,
    );
  });
});
