import { gunzipSync, gzipSync } from "node:zlib";
import type { PsycheDb } from "../open.ts";

/**
 * Forget's pass over the run trace. A forgotten phrase is queued in `trace_scrub_queue` (one row
 * per phrase) and a worker scrubs it in byte-budgeted batches, saving its cursor after each batch,
 * so a restart resumes where it stopped. Per row, the phrase becomes `[forgotten]` in:
 * the model-call payloads (`step_payloads`, gzip), a step's tool payloads, and each step's preview
 * (`run_steps.data`) and retained thinking (`run_steps.text_full`).
 */

/** What a forgotten phrase becomes in stored run-trace text. */
export const FORGOTTEN_MARKER = "[forgotten]";

/** Decoded bytes scrubbed per batch before the worker yields and saves its cursor. */
export const TRACE_SCRUB_BUDGET_BYTES = 2 * 1024 * 1024;

/** Most rows one SQL read hands back. */
const READ_ROWS = 50;
/** Raw bytes one SQL read hands back (a single larger row is still read alone). */
const READ_CHUNK_BYTES = 256 * 1024;

/**
 * Keys whose values are structure, not memory text: never rewritten. One list serves the JSON
 * walk and the text-mode guard. `*Id` is case-sensitive (`chatId` is an id, `paid` is not). `name`
 * is structure only in a tool-shaped object (see `isToolShaped`); elsewhere it can be a person.
 */
const STRUCTURAL_KEYS = [
  "role",
  "type",
  "kind",
  "id",
  "mime",
  "tool",
  "toolName",
  "stopReason",
  "finish",
];
const ID_KEY = "[A-Za-z0-9_]*Id";
const isStructuralKey = (k: string): boolean =>
  STRUCTURAL_KEYS.includes(k) || new RegExp(`^${ID_KEY}$`).test(k);

/** A `type` that marks a tool call or a tool result. */
const TOOL_TYPES = ["tool_use", "tool_result", "function"];
const isToolShaped = (o: Record<string, unknown>): boolean =>
  (typeof o.type === "string" && TOOL_TYPES.includes(o.type)) || "input" in o || "arguments" in o;

const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
/**
 * Text-mode guards (matched first, so what they match is left as it is, and case-sensitive):
 * a structural key's JSON value; a tool-shaped object's `name` (next to a tool `type`, before its
 * `input`/`arguments`); and the marker itself, so forgetting "forgotten" never wraps it again.
 */
const KEEP_SRC = [
  String.raw`(?-i:"(?:${STRUCTURAL_KEYS.join("|")}|${ID_KEY})"\s*:\s*${JSON_STRING})`,
  String.raw`(?-i:(?="name")(?<="type"\s*:\s*"(?:${TOOL_TYPES.join("|")})"\s*,\s*)"name"\s*:\s*${JSON_STRING})`,
  String.raw`(?-i:"name"\s*:\s*${JSON_STRING}(?=\s*,\s*"(?:input|arguments)"\s*:))`,
  String.raw`\[forgotten\]`,
].join("|");

// Same word characters as the memory side (`_` is not one there), so both forget the same lines.
const WORD_CHAR = String.raw`[\p{L}\p{N}]`;
/** Left and right boundaries; a JSON escape before the phrase (`\n`, `\t`, ...) counts as a boundary. */
const LEFT = String.raw`(?:(?<!${WORD_CHAR})|(?<=\\[nrtbf]))`;
const RIGHT = `(?!${WORD_CHAR})`;
/** Whitespace in the phrase matches whitespace or the JSON escapes of it. */
const SPACE = String.raw`(?:\s|\\[nrt]|\\u[0-9a-fA-F]{4})+`;

function escapeToken(c: string): string {
  if (c === '"') return String.raw`(?:"|\\")`;
  if (c === "\\") return String.raw`(?:\\\\|\\)`;
  return /[.*+?^${}()|[\]/]/.test(c) ? `\\${c}` : c;
}

/**
 * The phrase as it may appear in stored text: plain, or JSON-escaped (quotes, backslashes, line
 * breaks between words), whole words only. Matches are case-insensitive.
 */
export function phrasePattern(phrase: string, extra: string = KEEP_SRC): RegExp {
  const words = phrase
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const body = words.map((w) => [...w].map(escapeToken).join("")).join(SPACE);
  return new RegExp(`(${extra})|${LEFT}${body}${RIGHT}`, "giu");
}

/** Replacement for a match: a kept guard group or the phrase (marked). */
function replaceMatch(match: string, guard: string | undefined): string {
  return guard === undefined ? FORGOTTEN_MARKER : match;
}

/** The scrubber for one phrase: JSON-aware for intact rows, text-only for truncated ones. */
function makeScrubber(phrase: string): {
  json: (text: string) => string | undefined;
  text: (text: string) => string | undefined;
} {
  const pattern = phrasePattern(phrase);
  const replace = (s: string): string =>
    s.replace(pattern, (m: string, guard?: string) => replaceMatch(m, guard));
  // A string value is text; nested JSON text (MCP results, connector payloads) is scrubbed as
  // text too, in its escaped form, so every byte outside a match stays as it was (ids above 2^53,
  // formatting, number spelling).
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return replace(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const o = value as Record<string, unknown>;
      const tool = isToolShaped(o);
      return Object.fromEntries(
        Object.entries(o).map(([k, v]) => [
          k,
          isStructuralKey(k) || (k === "name" && tool) ? v : walk(v),
        ]),
      );
    }
    return value;
  };
  const text = (s: string): string | undefined => {
    const next = replace(s);
    return next === s ? undefined : next;
  };
  return {
    json: (s) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(s) as unknown;
      } catch {
        return text(s);
      }
      const walked = JSON.stringify(walk(parsed));
      return walked === JSON.stringify(parsed) ? undefined : walked;
    },
    text,
  };
}

/**
 * Runs `fn` with `secure_delete` on, so freed cells and pages are zeroed and the text a scrub
 * replaces does not linger in the file, then puts the setting back.
 */
export function withSecureDelete<T>(db: PsycheDb, fn: () => T): T {
  const previous = Number(db.sqlite.pragma("secure_delete", { simple: true }));
  db.sqlite.pragma("secure_delete = ON");
  try {
    return fn();
  } finally {
    db.sqlite.pragma(`secure_delete = ${Number.isInteger(previous) ? previous : 0}`);
  }
}

/** Queues a phrase for the trace pass. A phrase already queued starts its pass over. */
export function enqueueTraceScrub(db: PsycheDb, subject: string, now: string): void {
  db.sqlite.transaction(() => {
    const existing = db.sqlite
      .prepare("SELECT id FROM trace_scrub_queue WHERE subject = ?")
      .get(subject) as { id: number } | undefined;
    const id =
      existing?.id ??
      Number(
        db.sqlite
          .prepare("INSERT INTO trace_scrub_queue (subject, created_at) VALUES (?, ?)")
          .run(subject, now).lastInsertRowid,
      );
    db.sqlite.prepare("INSERT OR REPLACE INTO trace_scrub_state (queue_id) VALUES (?)").run(id);
  })();
}

export interface TraceScrubRow {
  readonly id: number;
  readonly subject: string;
  readonly phase: number;
  readonly cursor: number;
  /** The pass has begun (the runs it must wait for are recorded). */
  readonly started: boolean;
  /** Runs that were active when the pass began: they may write the text back, so a final pass follows. */
  readonly watchRuns: readonly string[];
  /** The final pass, which runs once the watched runs have ended (or after a day). */
  readonly final: boolean;
  /** When the final pass began waiting. */
  readonly finalSince: string | undefined;
  readonly rewritten: number;
  readonly skipped: number;
}

interface RawRow {
  id: number;
  subject: string;
  phase: number;
  cursor: number;
  started: number;
  watch_runs: string;
  final: number;
  final_since: string | null;
  rewritten: number;
  skipped: number;
}

const QUEUE_SQL = `SELECT q.id, q.subject, s.phase, s.cursor, s.started, s.watch_runs, s.final, s.final_since,
  s.rewritten, s.skipped
  FROM trace_scrub_queue q JOIN trace_scrub_state s ON s.queue_id = q.id
  ORDER BY q.created_at, q.id`;

function toRow(r: RawRow): TraceScrubRow {
  let watchRuns: string[] = [];
  try {
    const parsed = JSON.parse(r.watch_runs) as unknown;
    if (Array.isArray(parsed)) watchRuns = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // An unreadable list means nothing to wait for.
  }
  return {
    id: r.id,
    subject: r.subject,
    phase: r.phase,
    cursor: r.cursor,
    started: r.started === 1,
    watchRuns,
    final: r.final === 1,
    finalSince: r.final_since ?? undefined,
    rewritten: r.rewritten,
    skipped: r.skipped,
  };
}

/** Every queued phrase, oldest first. */
export function listTraceScrub(db: PsycheDb): TraceScrubRow[] {
  return (db.sqlite.prepare(QUEUE_SQL).all() as RawRow[]).map(toRow);
}

/** The oldest queued phrase, or `undefined` when the queue is empty. */
export function nextTraceScrub(db: PsycheDb): TraceScrubRow | undefined {
  return listTraceScrub(db)[0];
}

/** Marks that the pass began, with the runs active right then. */
export function beginTraceScrub(db: PsycheDb, id: number, activeRunIds: readonly string[]): void {
  db.sqlite
    .prepare("UPDATE trace_scrub_state SET started = 1, watch_runs = ? WHERE queue_id = ?")
    .run(JSON.stringify(activeRunIds), id);
}

/** Starts the final pass over again, from the top; it waits for the watched runs. */
export function restartTraceScrubFinal(db: PsycheDb, id: number, now: string): void {
  db.sqlite
    .prepare(
      "UPDATE trace_scrub_state SET phase = 0, cursor = 0, final = 1, final_since = ? WHERE queue_id = ?",
    )
    .run(now, id);
}

/**
 * Ends a phrase's pass: the rows go with their cells zeroed, and the WAL is folded into the
 * database file and cut, so the phrase is not left in either (best effort: a reader holding the
 * WAL open postpones the cut).
 */
export function deleteTraceScrub(db: PsycheDb, subject: string): void {
  withSecureDelete(db, () => {
    const row = db.sqlite
      .prepare("SELECT id FROM trace_scrub_queue WHERE subject = ?")
      .get(subject) as { id: number } | undefined;
    if (row !== undefined) {
      db.sqlite.prepare("DELETE FROM trace_scrub_state WHERE queue_id = ?").run(row.id);
      db.sqlite.prepare("DELETE FROM trace_scrub_queue WHERE id = ?").run(row.id);
    }
  });
  try {
    db.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // The next checkpoint folds it in.
  }
}

/** One table's reader: rows after a cursor, in rowid order. */
const READERS = [
  "SELECT rowid AS rid, data, truncated FROM step_payloads WHERE rowid > ? ORDER BY rowid",
  "SELECT rowid AS rid, data, mime, truncated, step_id FROM tool_payloads WHERE rowid > ? ORDER BY rowid",
  "SELECT rowid AS rid, data, text_full FROM run_steps WHERE rowid > ? ORDER BY rowid",
];

const rawSize = (r: Record<string, unknown>): number => {
  const data = (r.data as { length?: number } | null)?.length ?? 0;
  const full = (r.text_full as string | null | undefined)?.length ?? 0;
  return data + full;
};

type BatchRow = Pick<TraceScrubRow, "id" | "subject" | "phase" | "cursor">;
interface BatchResult {
  finished: boolean;
  rewritten: number;
  skipped: number;
}

/**
 * Scrubs rows from the saved cursor until `budgetBytes` of decoded text has been read, then saves
 * the cursor. Rows are streamed and only a bounded chunk is held. A row that throws is counted as
 * skipped and the pass goes on. Each write is its own statement, so no write transaction is held.
 * Returns `finished` when every table is done.
 */
export function runTraceScrubBatch(
  db: PsycheDb,
  row: BatchRow,
  budgetBytes: number = TRACE_SCRUB_BUDGET_BYTES,
): BatchResult {
  return withSecureDelete(db, () => scrubBatch(db, row, budgetBytes));
}

function scrubBatch(db: PsycheDb, row: BatchRow, budgetBytes: number): BatchResult {
  const scrub = makeScrubber(row.subject);
  const readers = READERS.map((sql) => db.sqlite.prepare(sql));
  const writeStep = db.sqlite.prepare("UPDATE step_payloads SET data = ? WHERE rowid = ?");
  const writeTool = db.sqlite.prepare("UPDATE tool_payloads SET data = ? WHERE rowid = ?");
  const writeRunStep = db.sqlite.prepare(
    "UPDATE run_steps SET data = ?, text_full = ? WHERE rowid = ?",
  );

  // Each handler scrubs one row and returns whether it was rewritten, plus the bytes it read.
  const handlers: ((r: Record<string, unknown>) => { changed: boolean; bytes: number })[] = [
    (r) => {
      const text = gunzipSync(Buffer.from(r.data as Buffer)).toString("utf8");
      const next = r.truncated === 1 ? scrub.text(text) : scrub.json(text);
      if (next !== undefined) writeStep.run(gzipSync(Buffer.from(next, "utf8")), r.rid);
      return { changed: next !== undefined, bytes: Buffer.byteLength(text) };
    },
    (r) => {
      // Only a step's own payloads: other tool payloads belong to no trace step.
      if (r.step_id === null) return { changed: false, bytes: 0 };
      const text = Buffer.from(r.data as Buffer).toString("utf8");
      const json = r.mime === "application/json" && r.truncated !== 1;
      const next = json ? scrub.json(text) : scrub.text(text);
      if (next !== undefined) writeTool.run(Buffer.from(next, "utf8"), r.rid);
      return { changed: next !== undefined, bytes: Buffer.byteLength(text) };
    },
    (r) => {
      const data = r.data as string;
      const full = r.text_full as string | null;
      const nextData = scrub.json(data);
      const nextFull = full === null ? undefined : scrub.text(full);
      if (nextData !== undefined || nextFull !== undefined) {
        writeRunStep.run(nextData ?? data, nextFull ?? full, r.rid);
      }
      return {
        changed: nextData !== undefined || nextFull !== undefined,
        bytes: Buffer.byteLength(data) + Buffer.byteLength(full ?? ""),
      };
    },
  ];

  let phase = row.phase;
  let cursor = row.cursor;
  let rewritten = 0;
  let skipped = 0;
  let bytes = 0;
  // Only the state row is written: the phrase's own row is never touched after it is queued.
  const save = () =>
    db.sqlite
      .prepare(
        "UPDATE trace_scrub_state SET phase = ?, cursor = ?, rewritten = rewritten + ?, skipped = skipped + ? WHERE queue_id = ?",
      )
      .run(phase, cursor, rewritten, skipped, row.id);

  while (phase < readers.length) {
    const reader = readers[phase];
    if (reader === undefined) break;
    // Stream up to a chunk, close the cursor, then write: a statement that writes cannot run
    // while one is still reading on this connection.
    const rows: Record<string, unknown>[] = [];
    let chunk = 0;
    let exhausted = true;
    for (const r of reader.iterate(cursor) as Iterable<Record<string, unknown>>) {
      rows.push(r);
      chunk += rawSize(r);
      if (rows.length >= READ_ROWS || chunk >= READ_CHUNK_BYTES) {
        exhausted = false;
        break;
      }
    }
    for (const r of rows) {
      try {
        const out = handlers[phase]?.(r);
        if (out?.changed) rewritten += 1;
        bytes += out?.bytes ?? 0;
      } catch {
        skipped += 1;
      }
      cursor = r.rid as number;
      if (bytes >= budgetBytes) {
        save();
        return { finished: false, rewritten, skipped };
      }
    }
    if (exhausted) {
      phase += 1;
      cursor = 0;
    }
  }
  save();
  return { finished: true, rewritten, skipped };
}
