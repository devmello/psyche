import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { PsycheError } from "@psyche/protocol";

/**
 * A skill folder as data: every file with its bytes and executable bit. Hashes and scans run over
 * the whole tree (review design-24: a hash over `SKILL.md` alone lets bundled scripts change).
 */
export interface SkillFile {
  bytes: Uint8Array;
  executable: boolean;
}

export type SkillTree = Map<string, SkillFile>;

export interface TreeLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_LIMITS: TreeLimits = {
  maxFiles: 200,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
};

/** OS litter that is neither hashed nor installed. */
const IGNORED = new Set([".DS_Store", ".git", "Thumbs.db", "__MACOSX"]);

/**
 * `LESSONS.md` at the top of a skill folder belongs to the teaching loop (docs/agent/
 * teaching-loop-2026.md §6): the owner's approved lessons for this skill, written only by the
 * Gateway after a card. It is not part of the skill's content: never hashed (a new lesson must
 * not turn an approved skill back into a draft), never installed from a bundle.
 */
export const LESSONS_FILE = "LESSONS.md";

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** `sha256:` over sorted `path NUL x|- NUL sha256(content)` lines. */
export function treeHash(tree: SkillTree): string {
  const h = createHash("sha256");
  for (const path of [...tree.keys()].sort()) {
    const f = tree.get(path) as SkillFile;
    h.update(`${path}\0${f.executable ? "x" : "-"}\0${sha256Hex(f.bytes)}\n`);
  }
  return `sha256:${h.digest("hex")}`;
}

/** A relative POSIX path that stays inside the skill folder. */
export function safeRelPath(path: string): string | undefined {
  if (path.includes("\0") || path.includes("\\")) return undefined;
  const norm = posix.normalize(path).replace(/^\.\/+/, "");
  if (norm === "." || norm === "" || norm.startsWith("../") || norm === "..") return undefined;
  if (posix.isAbsolute(norm)) return undefined;
  if (norm.split("/").some((seg) => seg === ".." || seg === "")) return undefined;
  return norm;
}

export class TreeBuilder {
  readonly tree: SkillTree = new Map();
  #total = 0;
  #limits: TreeLimits;

  constructor(limits: TreeLimits = DEFAULT_LIMITS) {
    this.#limits = limits;
  }

  add(path: string, bytes: Uint8Array, executable = false): void {
    const rel = safeRelPath(path);
    if (rel === undefined) throw new PsycheError("invalid_params", `unsafe path in skill: ${path}`);
    if (rel.split("/").some((seg) => IGNORED.has(seg))) return;
    if (rel === LESSONS_FILE) return;
    if (this.tree.size >= this.#limits.maxFiles)
      throw new PsycheError("invalid_params", `skill has more than ${this.#limits.maxFiles} files`);
    if (bytes.byteLength > this.#limits.maxFileBytes)
      throw new PsycheError(
        "invalid_params",
        `${rel} is larger than ${this.#limits.maxFileBytes} bytes`,
      );
    this.#total += bytes.byteLength;
    if (this.#total > this.#limits.maxTotalBytes)
      throw new PsycheError(
        "invalid_params",
        `skill is larger than ${this.#limits.maxTotalBytes} bytes`,
      );
    this.tree.set(rel, { bytes, executable });
  }
}

/**
 * Reads a skill folder. Symbolic links anywhere in it are refused (they could point outside the
 * folder), as are special files; limits bound size and file count.
 */
export function readSkillDir(dir: string, limits: TreeLimits = DEFAULT_LIMITS): SkillTree {
  const b = new TreeBuilder(limits);
  const walk = (abs: string, rel: string) => {
    for (const entry of readdirSync(abs).sort()) {
      if (IGNORED.has(entry)) continue;
      const p = join(abs, entry);
      const r = rel === "" ? entry : `${rel}/${entry}`;
      const st = lstatSync(p);
      if (st.isSymbolicLink())
        throw new PsycheError("invalid_params", `symbolic link in skill: ${r}`);
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) b.add(r, readFileSync(p), (st.mode & 0o111) !== 0);
      else throw new PsycheError("invalid_params", `special file in skill: ${r}`);
    }
  };
  walk(dir, "");
  return b.tree;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 text of a file, or `undefined` for binary content. */
export function textOf(file: SkillFile): string | undefined {
  if (file.bytes.includes(0)) return undefined;
  try {
    return decoder.decode(file.bytes);
  } catch {
    return undefined;
  }
}
