import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  AGENT_HOOKS,
  APPROVAL_TTL_MS,
  AUDIT_GENESIS_HASH,
  CREDENTIAL_FIELDS,
  EXEC_OUTPUT_CAP_BYTES,
  PLACEHOLDER_PATTERN,
  PROTECTED_MEMORY_FILES,
  parsePlaceholders,
  ResolvedSecret,
  TERMINAL_TASK_STATUSES,
} from "../src/index.ts";

describe("contracts: placeholders (security §4.5)", () => {
  it("parses every placeholder with its field", () => {
    const refs = parsePlaceholders(
      "user {{cred:github-login.username}} pass {{cred:github-login}} otp {{cred:gh.totp}}",
    );
    expect(refs.map((r) => [r.slug, r.field])).toEqual([
      ["github-login", "username"],
      ["github-login", undefined],
      ["gh", "totp"],
    ]);
    expect(refs[0]?.raw).toBe("{{cred:github-login.username}}");
    expect(refs[0]?.index).toBe(5);
  });

  it("rejects malformed slugs and fields", () => {
    for (const bad of [
      "{{cred:Upper}}",
      "{{cred:-lead}}",
      "{{cred:x.secret}}",
      "{{ cred:x }}",
      `{{cred:${"a".repeat(65)}}}`,
    ]) {
      expect(parsePlaceholders(bad), bad).toEqual([]);
    }
    expect(PLACEHOLDER_PATTERN.flags).not.toContain("g");
    expect(CREDENTIAL_FIELDS).toEqual(["username", "password", "totp", "token", "header"]);
  });
});

describe("contracts: ResolvedSecret", () => {
  const value = "hunter2-very-secret";
  const target = { kind: "origin" as const, value: "https://example.com" };

  it("never shows its value when logged or serialized", () => {
    const s = new ResolvedSecret(value, { credentialId: "cred_1", target });
    expect(String(s)).toBe("[redacted]");
    expect(`${s}`).toBe("[redacted]");
    expect(JSON.stringify({ s })).toBe('{"s":"[redacted]"}');
    expect(inspect(s, { showHidden: true })).not.toContain(value);
    expect(JSON.stringify(Object.entries(s))).not.toContain(value);
    expect(s.credentialId).toBe("cred_1");
  });

  it("is one-shot by default and can be disposed", () => {
    const s = new ResolvedSecret(value, { credentialId: "c", target });
    expect(s.use((v) => v.length)).toBe(value.length);
    expect(s.spent).toBe(true);
    expect(() => s.use((v) => v)).toThrow();
    const twice = new ResolvedSecret(value, { credentialId: "c", target, maxUses: 2 });
    twice.use(() => 0);
    twice.dispose();
    expect(() => twice.use((v) => v)).toThrow();
  });
});

describe("contracts: constants", () => {
  it("match the docs", () => {
    expect(APPROVAL_TTL_MS).toBe(30 * 60 * 1000);
    expect(EXEC_OUTPUT_CAP_BYTES).toBe(128 * 1024);
    expect(AUDIT_GENESIS_HASH).toMatch(/^sha256:0{64}$/);
    expect(AGENT_HOOKS[0]).toBe("before_model_resolve");
    expect(AGENT_HOOKS).toContain("before_tool_call");
    expect(PROTECTED_MEMORY_FILES).toContain("MEMORY.md");
    expect(TERMINAL_TASK_STATUSES).toEqual(["done", "failed", "cancelled"]);
  });
});
