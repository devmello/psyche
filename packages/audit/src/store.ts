import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
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
import { ensureOwnerOnly } from "@psyche/hostfs";
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
  /**
   * Lines newest first, read lazily so a caller that stops early reads only the tail. Same
   * lines as `entries()` reversed (except `line` numbers are omitted). Optional: callers fall
   * back to `entries()`. With `beforeSeq`, starts at the last line below that seq (lines at or
   * above it may be skipped; the log is in seq order).
   */
  entriesDesc?(beforeSeq?: number): Iterable<AuditLine>;
  /**
   * Lines in order, starting at or before the first line whose seq is >= `seq` (the log is in
   * seq order, so earlier lines have a lower seq). Read lazily. Optional.
   */
  entriesFromSeq?(seq: number): Iterable<AuditLine>;
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

  *entriesDesc(): Iterable<AuditLine> {
    for (let i = this.lines.length - 1; i >= 0; i -= 1) {
      yield parseLine(this.lines[i] ?? "", undefined, i + 1);
    }
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
    // Windows has no modes: an owner-only DACL on audit/, which the month files inherit.
    if (process.platform === "win32") ensureOwnerOnly(dir);
    else chmodSync(dir, DIR_MODE);
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

  /** Newest month first; within a file, lines are read in chunks from the end. */
  *entriesDesc(beforeSeq?: number): Iterable<AuditLine> {
    const files = this.monthFiles();
    const bounded = beforeSeq !== undefined && Number.isFinite(beforeSeq);
    // Months after the one holding `beforeSeq` only have seqs at or above it.
    for (let i = bounded ? this.#fileFor(files, beforeSeq) : files.length - 1; i >= 0; i -= 1) {
      const name = files[i];
      if (name === undefined) continue;
      const fd = openSync(join(this.dir, name), "r");
      try {
        // The size is fixed here: a line appended while we read is not part of this snapshot.
        const size = fstatSync(fd).size;
        const end =
          bounded && i === this.#fileFor(files, beforeSeq) ? seekExact(fd, size, beforeSeq) : size;
        for (const raw of backwardLines(fd, end)) yield parseLine(raw, name);
      } finally {
        closeSync(fd);
      }
    }
  }

  /**
   * Index of the last month file whose first seq is <= `seq` (binary search; a file with no
   * parsable line makes the order unknown, so fall back to checking every file).
   */
  #fileFor(files: string[], seq: number): number {
    let start = 0;
    let lo = 0;
    let hi = files.length - 1;
    let blind = false;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const first = this.#firstSeq(files[mid] as string);
      if (first === undefined) {
        blind = true;
        break;
      }
      if (first <= seq) {
        start = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (blind) {
      start = 0;
      for (let i = 0; i < files.length; i += 1) {
        const first = this.#firstSeq(files[i] as string);
        if (first !== undefined && first <= seq) start = i;
      }
    }
    return start;
  }

  /**
   * Starts in the month file that can hold `seq` and binary-searches it by byte offset, so a
   * single-seq lookup reads a few small regions instead of the history. The log is written in
   * seq order; an unparsable line is skipped while probing, as `query` skips it anyway.
   */
  *entriesFromSeq(seq: number): Iterable<AuditLine> {
    const files = this.monthFiles();
    const start = this.#fileFor(files, seq);
    for (let i = start; i < files.length; i += 1) {
      const name = files[i];
      if (name === undefined) continue;
      const fd = openSync(join(this.dir, name), "r");
      try {
        const size = fstatSync(fd).size;
        const from = i === start && seq > Number.NEGATIVE_INFINITY ? seekOffset(fd, size, seq) : 0;
        for (const raw of forwardLines(fd, size, from, SEEK_WINDOW * 4)) yield parseLine(raw, name);
      } finally {
        closeSync(fd);
      }
    }
  }

  /** seq of a month file's first parsable line; cached, since that line never changes. */
  readonly #firstSeqs = new Map<string, number>();
  #firstSeq(name: string): number | undefined {
    const known = this.#firstSeqs.get(name);
    if (known !== undefined) return known;
    const fd = openSync(join(this.dir, name), "r");
    try {
      for (const raw of forwardLines(fd, fstatSync(fd).size, 0, SEEK_WINDOW)) {
        const p = parseLine(raw, name);
        if (p.ok) {
          this.#firstSeqs.set(name, p.entry.seq);
          return p.entry.seq;
        }
      }
    } finally {
      closeSync(fd);
    }
    return undefined;
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

const CHUNK = 64 * 1024;
const SEEK_WINDOW = 4096;

/** Lines from byte `from` up to `size`, split like `splitLines` (a trailing newline ends a line). */
function* forwardLines(fd: number, size: number, from: number, chunk = CHUNK): Generator<string> {
  const buf = Buffer.allocUnsafe(chunk);
  let pos = from;
  let pending: Buffer = Buffer.alloc(0);
  while (pos < size) {
    const n = readSync(fd, buf, 0, Math.min(chunk, size - pos), pos);
    if (n <= 0) break;
    pos += n;
    let data =
      pending.length === 0
        ? Buffer.from(buf.subarray(0, n))
        : Buffer.concat([pending, buf.subarray(0, n)]);
    let nl = data.indexOf(0x0a);
    let begin = 0;
    while (nl >= 0) {
      yield data.toString("utf8", begin, nl);
      begin = nl + 1;
      nl = data.indexOf(0x0a, begin);
    }
    data = data.subarray(begin);
    pending = Buffer.from(data);
  }
  // A final line without a newline (a torn write) still counts as a line.
  if (pending.length > 0) yield pending.toString("utf8");
}

/** The lines of `[0, size)` last first. */
function* backwardLines(fd: number, size: number): Generator<string> {
  if (size === 0) return;
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = size;
  let pending: Buffer = Buffer.alloc(0);
  let atEnd = true;
  while (pos > 0) {
    const n = Math.min(CHUNK, pos);
    pos -= n;
    const got = readSync(fd, buf, 0, n, pos);
    if (got !== n) throw new Error("audit: short read");
    const data = Buffer.concat([buf.subarray(0, n), pending]);
    let end = data.length;
    // The newline that ends the file's last line does not start an empty one.
    if (atEnd && data[end - 1] === 0x0a) end -= 1;
    atEnd = false;
    while (end > 0) {
      const nl = data.lastIndexOf(0x0a, end - 1);
      if (nl < 0) break;
      yield data.toString("utf8", nl + 1, end);
      end = nl;
    }
    pending = Buffer.from(data.subarray(0, end));
    if (pos === 0) yield pending.toString("utf8");
  }
}

/**
 * Byte offset of a line from which a forward scan reaches the first line with seq >= `seq`
 * (everything before it has a lower seq). Binary search over offsets; each probe reads the
 * first parsable line at or after the midpoint.
 */
function seekOffset(fd: number, size: number, seq: number): number {
  let lo = 0;
  let hi = size;
  while (hi - lo > SEEK_WINDOW) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const probe = probeAt(fd, size, mid);
    if (probe === undefined || probe.seq >= seq) hi = mid;
    else lo = probe.offset;
  }
  return lo;
}

/** Offset of the first line whose seq is >= `seq`, or `size` when there is none. */
function seekExact(fd: number, size: number, seq: number): number {
  let offset = seekOffset(fd, size, seq);
  for (const raw of forwardLines(fd, size, offset, SEEK_WINDOW * 4)) {
    const p = parseLine(raw, undefined);
    if (p.ok && p.entry.seq >= seq) return offset;
    offset += Buffer.byteLength(raw, "utf8") + 1;
  }
  return size;
}

/** First parsable entry on a line that starts at or after `at`: its seq and line offset. */
function probeAt(
  fd: number,
  size: number,
  at: number,
): { seq: number; offset: number } | undefined {
  const buf = Buffer.allocUnsafe(SEEK_WINDOW);
  // Find the start of the next line (at itself when `at` is a line start).
  let pos = Math.max(at - 1, 0);
  let start: number | undefined = at === 0 ? 0 : undefined;
  while (start === undefined && pos < size) {
    const n = readSync(fd, buf, 0, Math.min(SEEK_WINDOW, size - pos), pos);
    if (n <= 0) return undefined;
    const nl = buf.subarray(0, n).indexOf(0x0a);
    if (nl >= 0) start = pos + nl + 1;
    else pos += n;
  }
  if (start === undefined) return undefined;
  let offset = start;
  for (const raw of forwardLines(fd, size, start, SEEK_WINDOW)) {
    const p = parseLine(raw, undefined);
    if (p.ok) return { seq: p.entry.seq, offset };
    offset += Buffer.byteLength(raw, "utf8") + 1;
    if (offset - start > 1024 * 1024) return undefined;
  }
  return undefined;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function parseLine(raw: string, file: string | undefined, line?: number): AuditLine {
  const where = {
    ...(file === undefined ? {} : { file }),
    ...(line === undefined ? {} : { line }),
  };
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
