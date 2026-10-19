import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { AuditEntry } from "@psyche/protocol";

/**
 * Where hash-chained entries live. The log computes hashes; a store only persists lines in order.
 * `entries()` yields `AuditLine`s so a verifier can report unparsable (torn or edited) lines.
 */
export type AuditLine =
  | { ok: true; entry: AuditEntry; file?: string; line?: number }
  | { ok: false; raw: string; file?: string; line?: number };

/** Signed checkpoint over `(seq, hash)`, so truncation of the tail is detectable (security §15.1). */
export interface AuditAnchor {
  seq: number;
  hash: string;
  ts: string;
  keyId: string;
  signature: string;
}

export interface AuditStore {
  /** Last parsable entry, if any. */
  tail(): AuditEntry | undefined;
  append(entry: AuditEntry): void;
  entries(): Iterable<AuditLine>;
  appendAnchor(anchor: AuditAnchor): void;
  anchors(): Iterable<AuditAnchor>;
}

export class MemoryAuditStore implements AuditStore {
  readonly lines: string[] = [];
  readonly anchorList: AuditAnchor[] = [];
  #tail: AuditEntry | undefined;

  tail(): AuditEntry | undefined {
    return this.#tail === undefined ? undefined : structuredClone(this.#tail);
  }

  append(entry: AuditEntry): void {
    this.lines.push(JSON.stringify(entry));
    this.#tail = structuredClone(entry);
  }

  *entries(): Iterable<AuditLine> {
    for (const [i, raw] of this.lines.entries()) yield parseLine(raw, undefined, i + 1);
  }

  appendAnchor(anchor: AuditAnchor): void {
    this.anchorList.push(structuredClone(anchor));
  }

  anchors(): Iterable<AuditAnchor> {
    return this.anchorList.map((a) => structuredClone(a));
  }
}

const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
export const ANCHOR_FILE = "anchors.jsonl";

export interface FileAuditStoreOptions {
  /** fsync after every line (default true): an entry is durable once `append` returns. */
  fsync?: boolean;
}

/**
 * `audit/YYYY-MM.jsonl`, one JSON object per line (security §15.1, data model §5). The month is
 * the entry's UTC `ts`; the chain continues across files, so the first entry of a month carries
 * the previous month's last hash. Directory 0700, files 0600 (security §14).
 */
export class FileAuditStore implements AuditStore {
  readonly dir: string;
  readonly #fsync: boolean;
  /** Files this process has written to (they end in a newline). */
  readonly #clean = new Set<string>();
  #tail: AuditEntry | undefined;

  constructor(dir: string, options: FileAuditStoreOptions = {}) {
    this.dir = dir;
    this.#fsync = options.fsync ?? true;
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    chmodSync(dir, DIR_MODE);
    this.#tail = this.#loadTail();
  }

  monthFiles(): string[] {
    return readdirSync(this.dir)
      .filter((f) => MONTH_FILE.test(f))
      .sort();
  }

  #loadTail(): AuditEntry | undefined {
    const files = this.monthFiles();
    for (let i = files.length - 1; i >= 0; i -= 1) {
      const name = files[i];
      if (name === undefined) continue;
      const lines = splitLines(readFileSync(join(this.dir, name), "utf8"));
      for (let j = lines.length - 1; j >= 0; j -= 1) {
        const parsed = parseLine(lines[j] ?? "", name, j + 1);
        if (parsed.ok) return parsed.entry;
      }
    }
    return undefined;
  }

  tail(): AuditEntry | undefined {
    return this.#tail === undefined ? undefined : structuredClone(this.#tail);
  }

  append(entry: AuditEntry): void {
    const name = `${entry.ts.slice(0, 7)}.jsonl`;
    if (!MONTH_FILE.test(name)) throw new Error(`audit entry ts ${entry.ts} has no month`);
    this.#appendLine(join(this.dir, name), JSON.stringify(entry));
    this.#tail = structuredClone(entry);
  }

  #appendLine(path: string, line: string): void {
    const fresh = !existsSync(path);
    const fd = openSync(path, "a", FILE_MODE);
    try {
      if (fresh) chmodSync(path, FILE_MODE);
      // A torn last line (crash mid-write) must not swallow the next entry.
      const prefix = !fresh && !this.#clean.has(path) && !endsWithNewline(path) ? "\n" : "";
      writeSync(fd, `${prefix}${line}\n`);
      if (this.#fsync) fsyncSync(fd);
      this.#clean.add(path);
    } finally {
      closeSync(fd);
    }
  }

  *entries(): Iterable<AuditLine> {
    for (const name of this.monthFiles()) {
      const lines = splitLines(readFileSync(join(this.dir, name), "utf8"));
      for (const [i, raw] of lines.entries()) yield parseLine(raw, name, i + 1);
    }
  }

  appendAnchor(anchor: AuditAnchor): void {
    this.#appendLine(join(this.dir, ANCHOR_FILE), JSON.stringify(anchor));
  }

  *anchors(): Iterable<AuditAnchor> {
    const path = join(this.dir, ANCHOR_FILE);
    if (!existsSync(path)) return;
    for (const raw of splitLines(readFileSync(path, "utf8"))) {
      try {
        yield JSON.parse(raw) as AuditAnchor;
      } catch {
        // An unreadable anchor proves nothing; verification relies on the remaining ones.
      }
    }
  }
}

function endsWithNewline(path: string): boolean {
  const size = statSync(path).size;
  if (size === 0) return true;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function parseLine(raw: string, file: string | undefined, line: number): AuditLine {
  const where = { ...(file === undefined ? {} : { file }), line };
  try {
    const value: unknown = JSON.parse(raw);
    if (isEntryShape(value)) return { ok: true, entry: value, ...where };
  } catch {
    // fall through
  }
  return { ok: false, raw, ...where };
}

function isEntryShape(v: unknown): v is AuditEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.seq === "number" &&
    typeof e.ts === "string" &&
    typeof e.kind === "string" &&
    typeof e.prev === "string" &&
    typeof e.hash === "string" &&
    typeof e.actor === "object" &&
    e.actor !== null &&
    typeof e.data === "object" &&
    e.data !== null
  );
}
