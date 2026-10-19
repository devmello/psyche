import { posix } from "node:path";
import type { SandboxScope } from "@psyche/protocol";
import { fail } from "./errors.ts";
import { WORKSPACE_PATH } from "./limits.ts";

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCOPE_KINDS: ReadonlySet<string> = new Set(["thread", "project", "task"]);

export function validateScope(scope: SandboxScope): void {
  if (
    typeof scope !== "object" ||
    scope === null ||
    !SCOPE_KINDS.has(scope.kind) ||
    typeof scope.id !== "string" ||
    scope.id === ""
  ) {
    fail("invalid_params", "scope must be {kind: thread|project|task, id: non-empty string}");
  }
}

export function validateArgv(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv) || argv.length === 0 || argv[0] === "") {
    fail("invalid_params", "argv must be a non-empty argument array");
  }
  for (const arg of argv) {
    if (typeof arg !== "string") fail("invalid_params", "every argv entry must be a string");
    if (arg.includes("\0")) fail("invalid_params", "argv entries must not contain NUL bytes");
  }
}

/** Container-side working directory: absolute, normalized, no NUL. */
export function validateCwd(cwd: unknown): string {
  if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.includes("\0")) {
    fail("invalid_params", "cwd must be an absolute container path");
  }
  return posix.normalize(cwd);
}

export function validateEnv(env: Record<string, string> | undefined): string[] {
  if (env === undefined) return [];
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY.test(key)) fail("invalid_params", `invalid environment variable name: ${key}`);
    if (typeof value !== "string" || value.includes("\0")) {
      fail("invalid_params", `environment variable ${key} must be a string without NUL bytes`);
    }
    pairs.push(`${key}=${value}`);
  }
  return pairs;
}

export function validateTimeout(timeoutMs: unknown, maxTimeoutMs: number): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    fail("invalid_params", "timeoutMs must be a positive number");
  }
  if (timeoutMs > maxTimeoutMs) {
    fail("invalid_params", `timeoutMs exceeds the ${maxTimeoutMs} ms maximum`);
  }
  return Math.ceil(timeoutMs);
}

/**
 * Workspace-relative path for the file API. Accepts `a/b`, `./a/b` or `/workspace/a/b`;
 * rejects other absolute paths, `..` escapes and NUL bytes. Returns "" for the root. The
 * in-container helper re-checks every component (and rejects symlinks) after resolution.
 */
export function workspaceRelative(path: string): string {
  if (typeof path !== "string" || path.includes("\0")) {
    fail("invalid_params", "path must be a string without NUL bytes");
  }
  let rel = path;
  if (rel.startsWith("/")) {
    if (rel !== WORKSPACE_PATH && !rel.startsWith(`${WORKSPACE_PATH}/`)) {
      fail("forbidden", `${path} is outside ${WORKSPACE_PATH}`);
    }
    rel = rel.slice(WORKSPACE_PATH.length);
  }
  const normalized = posix.normalize(`/${rel}`).slice(1);
  if (rel.split("/").includes("..")) fail("forbidden", `${path} escapes ${WORKSPACE_PATH}`);
  return normalized.replace(/\/$/, "");
}
