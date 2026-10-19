import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compilePolicy,
  globToRegExp,
  parsePolicy,
  parseRule,
  policySchemaJson,
  ruleMatches,
} from "../src/index.ts";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

describe("policy.json", () => {
  it("the checked-in schema matches the TypeBox definition (pnpm gen:schema)", () => {
    expect(JSON.parse(read("policy.schema.json"))).toEqual(JSON.parse(policySchemaJson()));
  });

  it("the example validates and compiles", () => {
    const policy = compilePolicy(parsePolicy(JSON.parse(read("policy.example.json"))));
    expect(policy.deny).toHaveLength(4);
    expect(policy.folders[0]?.path).toBe("/Users/me/Documents");
  });

  it("rejects unknown keys and bad values so a typo never disables a rule", () => {
    expect(() => parsePolicy({ denny: ["x"] })).toThrow(/policy/);
    expect(() => parsePolicy({ apps: { "com.x": "everything" } })).toThrow(/policy/);
    expect(() => parsePolicy({ deny: ["read_file(**/.env"] })).toThrow();
  });
});

describe("rules", () => {
  it("matches tool globs, tool(target) and target-kind rules on canonical targets", () => {
    const t = (kind: "origin" | "path" | "recipient", value: string) => ({ kind, value });
    expect(ruleMatches(parseRule("mcp__github__*"), "mcp__github__delete_repo", undefined)).toBe(
      true,
    );
    expect(
      ruleMatches(parseRule("read_file(**/.env)"), "read_file", t("path", "/Users/o/app/.env")),
    ).toBe(true);
    expect(
      ruleMatches(parseRule("read_file(**/.env)"), "read_file", t("path", "/Users/o/app/.envrc")),
    ).toBe(false);
    expect(
      ruleMatches(
        parseRule("origin:*.onion"),
        "browser.navigate",
        t("origin", "http://abc.ONION./x"),
      ),
    ).toBe(true);
    expect(
      ruleMatches(
        parseRule("origin:*.onion"),
        "browser.navigate",
        t("origin", "http://onion.example"),
      ),
    ).toBe(false);
    expect(
      ruleMatches(
        parseRule("recipient:*@evil.test"),
        "email.send",
        t("recipient", "Boss@Evil.Test"),
      ),
    ).toBe(true);
  });

  it("path globs keep * inside one segment; *. never covers the bare domain", () => {
    expect(globToRegExp("/a/*/c", "path").test("/a/b/x/c")).toBe(false);
    expect(globToRegExp("/a/**/c", "path").test("/a/b/x/c")).toBe(true);
    expect(globToRegExp("*.kayak.com", "plain").test("kayak.com")).toBe(false);
  });
});
