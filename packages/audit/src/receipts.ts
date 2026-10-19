import {
  type AuditLog,
  type Clock,
  type JsonObject,
  PsycheError,
  type Receipt,
  type ReceiptInput,
} from "@psyche/protocol";
import { monotonicFactory } from "ulid";
import { redactForAudit } from "./redact.ts";

/**
 * Receipts store (data model §5, security §3.11, §15.2): the evaluator's evidence and the Activity
 * view. Payloads are redacted before they are stored (no secrets, bodies as digests). An
 * `uncertain` receipt is never retried; `reconcile` records what the provider says afterwards.
 */

export interface ReceiptFilter {
  taskId?: string;
  toolCallId?: string;
  approvalId?: string;
  kind?: string;
  outcome?: Receipt["outcome"];
  limit?: number;
}

export interface ReceiptStore {
  insert(receipt: Receipt): void;
  get(id: string): Receipt | undefined;
  /** Oldest first. */
  query(filter: ReceiptFilter): Receipt[];
  update(receipt: Receipt): void;
}

export class MemoryReceiptStore implements ReceiptStore {
  readonly #rows = new Map<string, Receipt>();

  insert(receipt: Receipt): void {
    if (this.#rows.has(receipt.id))
      throw new PsycheError("conflict", `receipt ${receipt.id} exists`);
    this.#rows.set(receipt.id, structuredClone(receipt));
  }

  get(id: string): Receipt | undefined {
    const r = this.#rows.get(id);
    return r === undefined ? undefined : structuredClone(r);
  }

  query(filter: ReceiptFilter): Receipt[] {
    return [...this.#rows.values()]
      .filter((r) => matches(r, filter))
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
      .map((r) => structuredClone(r));
  }

  update(receipt: Receipt): void {
    if (!this.#rows.has(receipt.id)) throw new PsycheError("not_found", `receipt ${receipt.id}`);
    this.#rows.set(receipt.id, structuredClone(receipt));
  }
}

function matches(r: Receipt, f: ReceiptFilter): boolean {
  return (
    (f.taskId === undefined || r.taskId === f.taskId) &&
    (f.toolCallId === undefined || r.toolCallId === f.toolCallId) &&
    (f.approvalId === undefined || r.approvalId === f.approvalId) &&
    (f.kind === undefined || r.kind === f.kind) &&
    (f.outcome === undefined || r.outcome === f.outcome)
  );
}

/** The subset of better-sqlite3 the SQL stores use (keeps the native module out of this package). */
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface SqliteLike {
  prepare(sql: string): SqliteStatement;
}

interface ReceiptRow {
  id: string;
  short_id: string | null;
  kind: string;
  task_id: string | null;
  tool_call_id: string | null;
  approval_id: string | null;
  outcome: Receipt["outcome"];
  summary: string;
  external_refs: string;
  payload: string | null;
  created_at: string;
}

/** `receipts` table (migration `*_permissions_init.sql`). */
export class SqliteReceiptStore implements ReceiptStore {
  readonly #db: SqliteLike;

  constructor(db: SqliteLike) {
    this.#db = db;
  }

  insert(r: Receipt): void {
    this.#db
      .prepare(
        `INSERT INTO receipts (id, short_id, kind, task_id, tool_call_id, approval_id, outcome, summary,
           external_refs, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.shortId ?? null,
        r.kind,
        r.taskId,
        r.toolCallId,
        r.approvalId,
        r.outcome,
        r.summary,
        JSON.stringify(r.externalRefs),
        r.payload === null ? null : JSON.stringify(r.payload),
        r.createdAt,
        r.createdAt,
      );
  }

  get(id: string): Receipt | undefined {
    const row = this.#db.prepare("SELECT * FROM receipts WHERE id = ?").get(id) as
      | ReceiptRow
      | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  query(f: ReceiptFilter): Receipt[] {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, v: string | undefined) => {
      if (v === undefined) return;
      where.push(`${col} = ?`);
      params.push(v);
    };
    add("task_id", f.taskId);
    add("tool_call_id", f.toolCallId);
    add("approval_id", f.approvalId);
    add("kind", f.kind);
    add("outcome", f.outcome);
    const sql = `SELECT * FROM receipts${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at, rowid${f.limit === undefined ? "" : " LIMIT ?"}`;
    if (f.limit !== undefined) params.push(f.limit);
    return (this.#db.prepare(sql).all(...params) as ReceiptRow[]).map(fromRow);
  }

  update(r: Receipt): void {
    this.#db
      .prepare(
        `UPDATE receipts SET outcome = ?, summary = ?, external_refs = ?, payload = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        r.outcome,
        r.summary,
        JSON.stringify(r.externalRefs),
        r.payload === null ? null : JSON.stringify(r.payload),
        new Date().toISOString(),
        r.id,
      );
  }
}

function fromRow(row: ReceiptRow): Receipt {
  const r: Receipt = {
    id: row.id,
    kind: row.kind,
    taskId: row.task_id,
    toolCallId: row.tool_call_id,
    approvalId: row.approval_id,
    outcome: row.outcome,
    summary: row.summary,
    externalRefs: JSON.parse(row.external_refs) as Receipt["externalRefs"],
    payload: row.payload === null ? null : (JSON.parse(row.payload) as JsonObject),
    createdAt: row.created_at,
  };
  if (row.short_id !== null) r.shortId = row.short_id;
  return r;
}

export interface ReceiptsOptions {
  store?: ReceiptStore;
  audit?: AuditLog;
  clock?: Clock;
  newId?: () => string;
  redact?: (text: string) => string;
}

export interface ReconcileInput {
  outcome: Receipt["outcome"];
  externalRefs?: Record<string, string | number>;
  /** Why the outcome changed, e.g. `provider confirmed messages.get`. */
  note: string;
}

/** Records receipts, audits each one (`receipt.recorded`), and reconciles uncertain outcomes. */
export class Receipts {
  readonly store: ReceiptStore;
  readonly #audit: AuditLog | undefined;
  readonly #clock: Clock;
  readonly #newId: () => string;
  readonly #redact: ((text: string) => string) | undefined;
  #count = 0;

  constructor(options: ReceiptsOptions = {}) {
    this.store = options.store ?? new MemoryReceiptStore();
    this.#audit = options.audit;
    this.#clock = options.clock ?? { now: () => Date.now() };
    const ulid = monotonicFactory();
    this.#newId = options.newId ?? (() => `rcp_${ulid(this.#clock.now())}`);
    this.#redact = options.redact;
  }

  async record(input: ReceiptInput): Promise<Receipt> {
    const opts = this.#redact === undefined ? {} : { redact: this.#redact };
    this.#count += 1;
    const receipt: Receipt = {
      id: this.#newId(),
      shortId: input.shortId ?? `R${this.#count}`,
      kind: input.kind,
      taskId: input.taskId ?? null,
      toolCallId: input.toolCallId ?? null,
      approvalId: input.approvalId ?? null,
      outcome: input.outcome,
      summary: redactForAudit(input.summary, opts),
      externalRefs: redactForAudit({ ...(input.externalRefs ?? {}) }, opts),
      payload: input.payload == null ? null : (redactForAudit(input.payload, opts) as JsonObject),
      createdAt: new Date(this.#clock.now()).toISOString(),
    };
    this.store.insert(receipt);
    await this.#audit?.append({
      kind: "receipt.recorded",
      actor: { type: "system" },
      subject: {
        receiptId: receipt.id,
        ...(receipt.taskId === null ? {} : { taskId: receipt.taskId }),
        ...(receipt.toolCallId === null ? {} : { toolCallId: receipt.toolCallId }),
        ...(receipt.approvalId === null ? {} : { approvalId: receipt.approvalId }),
      },
      data: { kind: receipt.kind, outcome: receipt.outcome, externalRefs: receipt.externalRefs },
    });
    return structuredClone(receipt);
  }

  async get(id: string): Promise<Receipt | undefined> {
    return this.store.get(id);
  }

  async list(filter: ReceiptFilter = {}): Promise<Receipt[]> {
    return this.store.query(filter);
  }

  async reconcile(id: string, input: ReconcileInput): Promise<Receipt> {
    const current = this.store.get(id);
    if (current === undefined) throw new PsycheError("not_found", `receipt ${id} not found`);
    if (current.outcome !== "uncertain") {
      throw new PsycheError("conflict", `receipt ${id} is ${current.outcome}, not uncertain`);
    }
    const next: Receipt = {
      ...current,
      outcome: input.outcome,
      externalRefs: { ...current.externalRefs, ...(input.externalRefs ?? {}) },
    };
    this.store.update(next);
    await this.#audit?.append({
      kind: "receipt.reconciled",
      actor: { type: "system" },
      subject: { receiptId: id },
      data: { from: current.outcome, to: input.outcome, note: input.note },
    });
    return structuredClone(next);
  }
}
