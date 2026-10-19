import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  validateArgv,
  validateCwd,
  validateEnv,
  validateScope,
  validateTimeout,
  workspaceRelative,
} from "../src/validate.ts";

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof PsycheError ? e.code : "not-psyche";
  }
  return undefined;
}

describe("workspaceRelative", () => {
  it("accepts relative and /workspace paths", () => {
    expect(workspaceRelative("a/b.txt")).toBe("a/b.txt");
    expect(workspaceRelative("./a//b/")).toBe("a/b");
    expect(workspaceRelative("/workspace/a/b")).toBe("a/b");
    expect(workspaceRelative("/workspace")).toBe("");
    expect(workspaceRelative("")).toBe("");
  });

  it("rejects escapes, other absolute paths and NUL", () => {
    expect(code(() => workspaceRelative("../etc/passwd"))).toBe("forbidden");
    expect(code(() => workspaceRelative("a/../../x"))).toBe("forbidden");
    expect(code(() => workspaceRelative("a/../b"))).toBe("forbidden");
    expect(code(() => workspaceRelative("/etc/passwd"))).toBe("forbidden");
    expect(code(() => workspaceRelative("/workspacex/a"))).toBe("forbidden");
    expect(code(() => workspaceRelative("a\0b"))).toBe("invalid_params");
  });
});

describe("request validation", () => {
  it("argv must be a non-empty string array without NUL", () => {
    expect(code(() => validateArgv([]))).toBe("invalid_params");
    expect(code(() => validateArgv([""]))).toBe("invalid_params");
    expect(code(() => validateArgv("ls -la"))).toBe("invalid_params");
    expect(code(() => validateArgv(["ls", 1]))).toBe("invalid_params");
    expect(code(() => validateArgv(["ls", "a\0b"]))).toBe("invalid_params");
    expect(code(() => validateArgv(["A=1", "ls"]))).toBe("invalid_params");
    expect(code(() => validateArgv(["ls", "-la", "a=b"]))).toBeUndefined();
  });

  it("cwd must be absolute", () => {
    expect(validateCwd("/workspace/a/../b")).toBe("/workspace/b");
    expect(code(() => validateCwd("workspace"))).toBe("invalid_params");
  });

  it("env names must be shell identifiers", () => {
    expect(validateEnv({ A_1: "x y", PSYCHE_SECRET_X: "s" })).toEqual([
      "A_1=x y",
      "PSYCHE_SECRET_X=s",
    ]);
    expect(code(() => validateEnv({ "A=B": "x" }))).toBe("invalid_params");
    expect(code(() => validateEnv({ "1A": "x" }))).toBe("invalid_params");
    expect(code(() => validateEnv({ A: "x\0" }))).toBe("invalid_params");
  });

  it("timeouts are positive and bounded", () => {
    expect(validateTimeout(1500.2, 10_000)).toBe(1501);
    expect(code(() => validateTimeout(0, 10_000))).toBe("invalid_params");
    expect(code(() => validateTimeout(Number.NaN, 10_000))).toBe("invalid_params");
    expect(code(() => validateTimeout(10_001, 10_000))).toBe("invalid_params");
  });

  it("scopes need a known kind and an id", () => {
    expect(code(() => validateScope({ kind: "task", id: "" }))).toBe("invalid_params");
    expect(code(() => validateScope({ kind: "host" as "task", id: "x" }))).toBe("invalid_params");
    expect(code(() => validateScope({ kind: "thread", id: "x" }))).toBeUndefined();
  });
});
