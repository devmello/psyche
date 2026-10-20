import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import type { SandboxMount, SandboxScope } from "@psyche/protocol";
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
  // The wrapper runs `env -- NAME=value… argv`, which would read such an argv[0] as a variable.
  if ((argv[0] as string).includes("=")) {
    fail("invalid_params", "argv[0] must not contain '='");
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

const under = (child: string, root: string) =>
  root === "/" ? true : child === root || child.startsWith(`${root}/`);

/**
 * Bind-mount sources and targets (security §5.1 "mount sources are validated … after path
 * resolution"; §13's never-shared roots). The caller (the coding helper) checks the owner's
 * folder grant; this refuses what no grant can make safe: a source that is not its own real
 * path (a symlink could point it anywhere after the check), `/`, the home folder itself, any
 * ancestor of it, `~/Library`, `$PSYCHE_HOME` and `protectedRoots`; and a target outside
 * `/workspace/`. Commas and `=` are refused because `--mount` is a comma-separated list.
 */
export async function validateMounts(
  mounts: unknown,
  protectedRoots: readonly string[] = [],
): Promise<SandboxMount[]> {
  if (mounts === undefined) return [];
  if (!Array.isArray(mounts) || mounts.length > 8) {
    fail("invalid_params", "mounts must be an array of at most 8 entries");
  }
  const home = homedir();
  const never = [`${home}/Library`, ...protectedRoots].map((p) => posix.normalize(p));
  const out: SandboxMount[] = [];
  for (const m of mounts as SandboxMount[]) {
    const { source, target, readOnly } = m ?? ({} as SandboxMount);
    if (typeof source !== "string" || typeof target !== "string" || typeof readOnly !== "boolean") {
      fail("invalid_params", "a mount is {source, target, readOnly}");
    }
    for (const v of [source, target]) {
      if (!v.startsWith("/") || v.includes("\0") || v.includes(",") || v.includes("=")) {
        fail("forbidden", `mount path ${JSON.stringify(v)} is not allowed`);
      }
    }
    let real: string;
    try {
      real = await realpath(source);
      await stat(real);
    } catch {
      return fail("not_found", `mount source ${source} does not exist`);
    }
    if (real !== source) fail("forbidden", `mount source ${source} goes through a symlink`);
    if (
      source === "/" ||
      under(home, source) ||
      never.some((r) => under(source, r) || under(r, source))
    ) {
      fail("forbidden", `${source} is never mounted into a sandbox`);
    }
    const t = posix.normalize(target);
    if (t !== target || !t.startsWith(`${WORKSPACE_PATH}/`)) {
      fail(
        "forbidden",
        `mount target ${target} must be a normalized path under ${WORKSPACE_PATH}/`,
      );
    }
    out.push({ source, target, readOnly });
  }
  // A read-only mount nested in a read-write one is fine; the same target twice is not.
  if (new Set(out.map((m) => m.target)).size !== out.length) {
    fail("invalid_params", "two mounts share a target");
  }
  return out.sort((a, b) => a.target.length - b.target.length);
}

/** Order-independent identity of a mount list (config label, conflict check). */
export function mountsKey(mounts: readonly SandboxMount[]): string {
  return JSON.stringify(
    [...mounts]
      .map((m) => [m.target, m.source, m.readOnly])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
  );
}
