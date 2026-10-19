import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { blockingKinds } from "./filters.ts";
import { canonicalCase } from "./layout.ts";

/**
 * Workspace path confinement. Every path the store accepts is relative to the workspace, uses
 * `/`, has no `.`/`..`/empty segment, no hidden segment (`.git`, `.DS_Store`), only ordinary
 * name characters, and no symlinked component. Paths are also canonicalized to the spelling
 * on disk (macOS volumes are case-insensitive, so `soul.md` *is* `SOUL.md`): every policy
 * decision is made on the canonical path.
 */

const MAX_PATH = 1024;
const MAX_SEGMENT = 128;
/** Letters, digits, space, `.`, `_`, `-`, `(`, `)`, `+`, `,`, `'`, `&` in any script. */
const SEGMENT = /^[\p{L}\p{N}\p{M} ._\-()+,'&]+$/u;

export function invalidPath(message: string): never {
  throw new PsycheError("invalid_params", message);
}

/** Validates and normalizes a workspace-relative path; throws `invalid_params`. */
export function normalizeWorkspacePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) invalidPath("workspace path is empty");
  if (path.length > MAX_PATH) invalidPath("workspace path is too long");
  if (path.includes("\0")) invalidPath("workspace path contains NUL");
  if (path.startsWith("/") || path.includes("\\") || /^[a-zA-Z]:/.test(path)) {
    invalidPath("workspace paths must be relative");
  }
  const parts = path.split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) {
    invalidPath("path traversal is not allowed");
  }
  if (parts.some((p) => p.startsWith("."))) invalidPath("hidden files are not workspace files");
  if (parts.some((p) => p.length > MAX_SEGMENT || !SEGMENT.test(p) || p !== p.trim())) {
    invalidPath("workspace file names may use letters, digits, spaces and . _ - ( ) + , ' &");
  }
  // File names are model-visible too: no credentials or card numbers in them.
  if (blockingKinds(path.replace(/[/.]/g, " "), true).length > 0) {
    invalidPath("workspace file names cannot contain credentials or card numbers");
  }
  return parts.join("/");
}

/**
 * Canonical workspace path: each existing component takes its on-disk spelling (an exact match
 * first, then a case-insensitive one), and well-known names take their canonical case
 * (`SOUL.md`, `memory/`, `skills/`), so case variants cannot slip past a policy check.
 */
export function canonicalWorkspacePath(root: string, rel: string): string {
  const parts = normalizeWorkspacePath(rel).split("/");
  let dir = root;
  const out: string[] = [];
  for (const part of parts) {
    let name = part;
    if (existsSync(dir)) {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        entries = [];
      }
      if (!entries.includes(part)) {
        const lower = part.toLowerCase();
        name = entries.find((e) => e.toLowerCase() === lower) ?? part;
      }
    }
    out.push(name);
    dir = join(dir, name);
  }
  return canonicalCase(out.join("/"));
}

/**
 * Absolute path of a canonical workspace path. Refuses any symlinked component below the root,
 * so a link inside the workspace cannot redirect a write (outside it, or onto a protected file
 * under another name).
 */
export function resolveInWorkspace(root: string, rel: string): string {
  const normalized = normalizeWorkspacePath(rel);
  const realRoot = realpathSync(root);
  let current = realRoot;
  for (const part of normalized.split("/")) {
    current = join(current, part);
    let isLink = false;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      break; // does not exist yet; nothing below it exists either
    }
    if (isLink) invalidPath("symlinks inside the workspace are not followed");
  }
  const target = join(realRoot, ...normalized.split("/"));
  const fromRoot = relative(realRoot, target);
  if (fromRoot.startsWith("..") || fromRoot.split(sep).includes("..")) {
    invalidPath("path escapes the workspace");
  }
  return target;
}

/** Workspace-relative `/` path of an absolute path under `root`. */
export function toWorkspacePath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}
