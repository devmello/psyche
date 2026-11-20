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

/** Rows fetched per SQL read inside a batch. */
const READ_ROWS = 50;

/** Keys whose values are structure, not memory text: never rewritten. */
const STRUCTURAL_KEYS = new Set([
  "role",
  "type",
  "kind",
  "status",
  "name",
  "id",
  "mime",
  "tool",
  "toolName",
  "stopReason",
  "finish",
]);
const isStructuralKey = (k: string): boolean => STRUCTURAL_KEYS.has(k) || /Id$/.test(k);

/** Text-mode guard: a structural key's JSON value (matched first, so it is left as it is). */
const STRUCTURAL_JSON_SRC = String.raw`"(?:role|type|kind|status|name|id|mime|tool|toolName|stopReason|finish|\w*Id)"\s*:\s*"(?:[^"\\]|\\.)*"`;

const WORD_CHAR = String.raw`[\p{L}\p{N}_]`;
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
export function phrasePattern(phrase: string, extra?: string): RegExp {
  const words = phrase
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const body = words.map((w) => [...w].map(escapeToken).join("")).join(SPACE);
  const phrase_ = `${LEFT}${body}${RIGHT}`;
  const src = extra === undefined ? phrase_ : `(${extra})|${phrase_}`;
  return new RegExp(src, "giu");
}

/** Replacement for a match: a structural guard group (kept) or the phrase (marked). */
function replaceMatch(match: string, guard: string | undefined): string {
  return guard === undefined ? FORGOTTEN_MARKER : match;
}

/** The scrubber for one phrase: JSON-aware for intact rows, text-only for truncated ones. */
function makeScrubber(phrase: string): {
  json: (text: string) => string | undefined;
  text: (text: string) => string | undefined;
} {
  const pattern = phrasePattern(phrase, STRUCTURAL_JSON_SRC);
  const scrubString = (s: string): string => {
    const t = s.trimStart();
    if (t.startsWith("{") || t.startsWith("[")) {
      // Nested JSON text (MCP results, connector payloads): scrub its own values.
      try {
        const parsed = JSON.parse(s) as unknown;
        const before = JSON.stringify(parsed);
        const after = JSON.stringify(walk(parsed));
        return after === before ? s : after;
      } catch {
        // Clipped (a preview): fall through to the escaped-text match.
      }
    }
    return s.replace(pattern, (m: string, guard?: string) => replaceMatch(m, guard));
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return scrubString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, isStructuralKey(k) ? v : walk(v)]),
      );
    }
    return value;
  };
  const text = (s: string): string | undefined => {
    const next = s.replace(pattern, (m: string, guard?: string) => replaceMatch(m, guard));
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
      const next = JSON.stringify(walk(parsed));
      return next === s ? undefined : next;
    },
    text,
  };
}

/** Queues a phrase for the trace pass. A phrase already queued starts its pass over. */
export function enqueueTraceScrub(db: PsycheDb, subject: string, now: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO trace_scrub_queue (subject, created_at) VALUES (?, ?)
       ON CONFLICT (subject) DO UPDATE SET phase = 0, cursor = 0, watch = 0, final = 0, rewritten = 0, skipped = 0`,
    )
    .run(subject, now);
}

export interface TraceScrubRow {
  readonly subject: string;
  readonly phase: number;
  readonly cursor: number;
  /** A run was active when the pass began: a final pass follows once the runs end. */
  readonly watch: boolean;
  /** The final pass, which runs once no run is active. */
  readonly final: boolean;
  readonly rewritten: number;
  readonly skipped: number;
}

/** The oldest queued phrase, or `undefined` when the queue is empty. */
export function nextTraceScrub(db: PsycheDb): TraceScrubRow | undefined {
  const row = db.sqlite
    .prepare(
      "SELECT subject, phase, cursor, watch, final, rewritten, skipped FROM trace_scrub_queue ORDER BY created_at, subject LIMIT 1",
    )
    .get() as
    | {
        subject: string;
        phase: number;
        cursor: number;
        watch: number;
        final: number;
        rewritten: number;
        skipped: number;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    subject: row.subject,
    phase: row.phase,
    cursor: row.cursor,
    watch: row.watch === 1,
    final: row.final === 1,
    rewritten: row.rewritten,
    skipped: row.skipped,
  };
}

/** Marks that a run was active when the pass began. */
export function markTraceScrubWatch(db: PsycheDb, subject: string): void {
  db.sqlite.prepare("UPDATE trace_scrub_queue SET watch = 1 WHERE subject = ?").run(subject);
}

/** Starts the final pass over again, from the top, once runs have ended. */
export function restartTraceScrubFinal(db: PsycheDb, subject: string): void {
  db.sqlite
    .prepare(
      "UPDATE trace_scrub_queue SET phase = 0, cursor = 0, watch = 0, final = 1 WHERE subject = ?",
    )
    .run(subject);
}

export function deleteTraceScrub(db: PsycheDb, subject: string): void {
  db.sqlite.prepare("DELETE FROM trace_scrub_queue WHERE subject = ?").run(subject);
}

/**
 * Scrubs rows from the saved cursor until `budgetBytes` of decoded text has been read, then saves
 * the cursor. A row that throws is counted as skipped and the pass goes on. Each write is its own
 * statement, so no write transaction is held. Returns `finished` when every table is done.
 */
export function runTraceScrubBatch(
  db: PsycheDb,
  row: Pick<TraceScrubRow, "subject" | "phase" | "cursor">,
  budgetBytes: number = TRACE_SCRUB_BUDGET_BYTES,
): { finished: boolean; rewritten: number; skipped: number } {
  const scrub = makeScrubber(row.subject);
  const readers = [
    db.sqlite.prepare(
      "SELECT rowid AS rid, data, truncated FROM step_payloads WHERE rowid > ? ORDER BY rowid LIMIT ?",
    ),
    db.sqlite.prepare(
      "SELECT rowid AS rid, data, mime, truncated, step_id FROM tool_payloads WHERE rowid > ? ORDER BY rowid LIMIT ?",
    ),
    db.sqlite.prepare(
      "SELECT rowid AS rid, data, text_full FROM run_steps WHERE rowid > ? ORDER BY rowid LIMIT ?",
    ),
  ];
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
  const save = () =>
    db.sqlite
      .prepare(
        "UPDATE trace_scrub_queue SET phase = ?, cursor = ?, rewritten = rewritten + ?, skipped = skipped + ? WHERE subject = ?",
      )
      .run(phase, cursor, rewritten, skipped, row.subject);
  // Counts are added to the row, so a batch's totals are reset here before the next one.
  rewritten = 0;
  skipped = 0;

  while (phase < readers.length) {
    const reader = readers[phase];
    if (reader === undefined) break;
    const rows = reader.all(cursor, READ_ROWS) as Record<string, unknown>[];
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
    if (rows.length < READ_ROWS) {
      phase += 1;
      cursor = 0;
    }
  }
  save();
  return { finished: true, rewritten, skipped };
}
