import { describe, expect, it } from "vitest";
import { CanonicalizationError, canonicalJSON, hashCanonical } from "../src/index.ts";

describe("canonicalJSON", () => {
  it("sorts keys, drops undefined members and has no whitespace", () => {
    expect(canonicalJSON({ b: 1, a: [true, null, "x"], c: undefined })).toBe(
      '{"a":[true,null,"x"],"b":1}',
    );
  });

  it("sorts keys by UTF-16 code units (RFC 8785 §3.2.3)", () => {
    // U+FB33 sorts before U+1F600 by code points, after it by UTF-16 code units (D83D DE00).
    const value = { "\ufb33": 1, "\ud83d\ude00": 2, "\r": 3, "1": 4, ö: 5 };
    expect(canonicalJSON(value)).toBe('{"\\r":3,"1":4,"ö":5,"\ud83d\ude00":2,"\ufb33":1}');
  });

  it("uses ECMAScript number serialization", () => {
    expect(canonicalJSON([1e21, 1e-7, 0.1, 100, 333333333.3333333])).toBe(
      "[1e+21,1e-7,0.1,100,333333333.3333333]",
    );
  });

  it.each([
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["-Infinity", { a: Number.NEGATIVE_INFINITY }],
    ["-0", { a: -0 }],
    ["Map", { m: new Map([["x", "rm -rf /"]]) }],
    ["Set", { s: new Set([1]) }],
    ["Date", { d: new Date(0) }],
    ["Buffer", { b: Buffer.from("x") }],
    ["Uint8Array", { b: new Uint8Array([1]) }],
    ["class instance", { c: new (class Foo {})() }],
    ["undefined in array", { a: [undefined] }],
    // biome-ignore lint/suspicious/noSparseArray: the hole is the test input
    ["array hole", { a: [1, , 2] }],
    ["BigInt", { n: 1n }],
    ["function", { f: () => 1 }],
    ["symbol", { s: Symbol("x") }],
    ["lone high surrogate", { s: "\uD800" }],
    ["lone low surrogate", { s: "a\uDC00" }],
    ["lone surrogate key", { "\uD800": 1 }],
    ["top-level undefined", undefined],
  ])("throws on %s instead of colliding", (_name, value) => {
    expect(() => canonicalJSON(value)).toThrow(CanonicalizationError);
    expect(() => canonicalJSON(value)).toThrow(/canonical/);
  });

  it("throws on cycles but accepts shared (acyclic) references", () => {
    const shared = { x: 1 };
    expect(canonicalJSON({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJSON(cyclic)).toThrow(/cycle/);
  });

  it("accepts null-prototype objects", () => {
    const o = Object.assign(Object.create(null), { b: 2, a: 1 });
    expect(canonicalJSON(o)).toBe('{"a":1,"b":2}');
  });

  it("does not NFC-fold: NFC and NFD strings hash differently (design-13)", () => {
    const nfc = "café";
    const nfd = "café";
    expect(hashCanonical({ argv: ["rm", nfc] })).not.toBe(hashCanonical({ argv: ["rm", nfd] }));
  });

  it("distinguishes values that look alike", () => {
    expect(hashCanonical({ a: null })).not.toBe(hashCanonical({ a: 0 }));
    expect(hashCanonical({ a: "1" })).not.toBe(hashCanonical({ a: 1 }));
    expect(hashCanonical({ a: [] })).not.toBe(hashCanonical({ a: {} }));
  });
});
