import type { PsycheDb } from "@psyche/db";
import type { ChecklistItem } from "@psyche/protocol";
import {
  type ApprovalRequest,
  type CheckpointInput,
  type ClaimOptions,
  type Clock,
  createValidator,
  type InputRequest,
  type JsonObject,
  PsycheError,
  Question,
  type RunMode,
  type Task,
  type TaskAction,
  type TaskCheckpoint,
  type TaskEngine,
  type TaskFilter,
  type TaskLease,
  type TaskPlan,
  type TaskStatus,
  TERMINAL_TASK_STATUSES,
} from "@psyche/protocol";
import {
  type ActionRow,
  actionFromRow,
  type CheckpointRow,
  checkpointFromRow,
  type InputRow,
  inputFromRow,
  json,
  parseJson,
  type TaskRow,
  taskFromRow,
} from "./rows.ts";
import type {
  ActionInput,
  Awaiting,
  CreateTaskInput,
  Level3Store,
  Page,
  ResumeItem,
  TaskBudget,
  TaskEngineEvent,
  TaskEventListener,
  TaskRecord,
} from "./types.ts";

export interface SqliteTaskEngineOptions {
  db: PsycheDb;
  clock: Clock;
  /** Defaults to `db.newId`. */
  newId?: () => string;
  /**
   * The Gateway's global state version (data model §11), bumped once per emitted event. Falls
   * back to a counter local to this engine.
   */
  nextStateVersion?: () => number;
  level3?: Level3Store;
}

/** Longest level-1 status line kept; longer lines are cut with an ellipsis. */
export const LEVEL1_MAX = 200;

const questionValidator = createValidator(Question);
const isTerminal = (s: TaskStatus) => TERMINAL_TASK_STATUSES.includes(s);

type UpdatedEvent = { event: "task.updated"; payload: { task: Task } };
type ActionEvent = { event: "task.action"; payload: { action: TaskAction } };
type PendingEvent = UpdatedEvent | ActionEvent;

/** The task carried by the last `task.updated` event of a mutation. */
function lastTask(events: PendingEvent[]): Task {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.event === "task.updated") return e.payload.task;
  }
  throw new PsycheError("internal", "mutation emitted no task.updated");
}

function fail(code: PsycheError["code"], message: string): never {
  throw new PsycheError(code, message);
}

/** One line, trimmed, at most `LEVEL1_MAX` characters (the Activity status line). */
export function normalizeLevel1(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= LEVEL1_MAX ? line : `${line.slice(0, LEVEL1_MAX - 1)}…`;
}

/** Keyset cursors: the sort key of the last row returned, so updates never shift pages. */
function encodeCursor(key: (string | number)[]): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

function decodeCursor(cursor: string | undefined, arity: number): (string | number)[] | undefined {
  if (cursor === undefined) return undefined;
  try {
    const key = JSON.parse(Buffer.from(cursor, "base64url").toString()) as unknown;
    if (Array.isArray(key) && key.length === arity) return key as (string | number)[];
  } catch {
    // fall through
  }
  return fail("invalid_params", "bad cursor");
}

/**
 * SQLite task engine (architecture §4.5; data model §3). Every mutation is one
 * `BEGIN IMMEDIATE` transaction on better-sqlite3, so concurrent workers (other connections
 * to the same file, or other loops in this process) never both win a claim. Events are emitted
 * after the transaction commits.
 */
export class SqliteTaskEngine implements TaskEngine {
  readonly clock: Clock;
  readonly #db: PsycheDb;
  readonly #newId: () => string;
  readonly #nextStateVersion: () => number;
  readonly #level3: Level3Store | undefined;
  readonly #listeners = new Set<TaskEventListener>();
  #localVersion = 0;

  constructor(options: SqliteTaskEngineOptions) {
    this.#db = options.db;
    this.clock = options.clock;
    this.#newId = options.newId ?? options.db.newId;
    this.#nextStateVersion = options.nextStateVersion ?? (() => ++this.#localVersion);
    this.#level3 = options.level3;
  }

  /** Receives `task.updated` / `task.action` after each committed mutation. */
  subscribe(listener: TaskEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // --- internals --------------------------------------------------------------------------------

  #iso(offsetMs = 0): string {
    return new Date(this.clock.now() + offsetMs).toISOString();
  }

  #emit(events: (PendingEvent | undefined)[]): void {
    for (const e of events) {
      if (e === undefined) continue;
      const full = { ...e, stateVersion: this.#nextStateVersion() } as TaskEngineEvent;
      for (const l of this.#listeners) {
        try {
          l(full);
        } catch {
          // A listener's failure never undoes a committed mutation.
        }
      }
    }
  }

  #tx<T>(fn: () => T): T {
    return this.#db.sqlite.transaction(fn).immediate();
  }

  #row(taskId: string): TaskRow {
    const row = this.#db.sqlite.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    if (row === undefined) return fail("not_found", `task ${taskId} not found`);
    return row;
  }

  #updated(taskId: string): UpdatedEvent {
    return { event: "task.updated", payload: { task: taskFromRow(this.#row(taskId)) } };
  }

  /**
   * Sets `status`; every state but `running` drops the lease and settles steps still `running`
   * (unsafe → `uncertain`; safe → `failed` when terminal, else `pending`). Rejects leaving a
   * terminal status.
   */
  #setStatus(row: TaskRow, status: TaskStatus, extra: Record<string, unknown> = {}): void {
    const from = row.status as TaskStatus;
    if (isTerminal(from) && status !== from) fail("conflict", `task ${row.id} is ${from}`);
    const now = this.#iso();
    const keepsLease = status === "running";
    if (!keepsLease) this.#settleInFlight(row.id, isTerminal(status) ? "failed" : "pending");
    const cols: Record<string, unknown> = {
      status,
      updated_at: now,
      ...(keepsLease ? {} : { lease_owner: null, lease_until: null, lease_token: null }),
      ...(isTerminal(status) ? { completed_at: now, awaiting: null } : {}),
      ...extra,
    };
    this.#patch(row.id, cols);
  }

  #patch(taskId: string, cols: Record<string, unknown>): void {
    const keys = Object.keys(cols);
    if (keys.length === 0) return;
    const sql = `UPDATE tasks SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @__id`;
    this.#db.sqlite.prepare(sql).run({ ...cols, __id: taskId });
  }

  #pushResume(row: TaskRow, item: ResumeItem): string {
    const list = parseJson<ResumeItem[]>(row.resume) ?? [];
    list.push(item);
    row.resume = JSON.stringify(list);
    return row.resume;
  }

  /** In-flight checkpoints when work stops: unsafe → `uncertain`, safe → `safeTo`. */
  #settleInFlight(taskId: string, safeTo: "pending" | "failed"): string[] {
    const now = this.#iso();
    const running = this.#db.sqlite
      .prepare(
        "SELECT step_id, replay_safe FROM task_checkpoints WHERE task_id = ? AND status = 'running' ORDER BY idx",
      )
      .all(taskId) as { step_id: string; replay_safe: number }[];
    const uncertain: string[] = [];
    const upd = this.#db.sqlite.prepare(
      "UPDATE task_checkpoints SET status = ?, updated_at = ? WHERE task_id = ? AND step_id = ?",
    );
    for (const c of running) {
      const to = c.replay_safe === 1 ? safeTo : "uncertain";
      if (to === "uncertain") uncertain.push(c.step_id);
      upd.run(to, now, taskId, c.step_id);
    }
    return uncertain;
  }

  #insertAction(taskId: string, input: ActionInput): TaskAction {
    const idx = (
      this.#db.sqlite
        .prepare("SELECT COALESCE(MAX(idx) + 1, 0) AS n FROM task_actions WHERE task_id = ?")
        .get(taskId) as { n: number }
    ).n;
    if (typeof input.level2?.tool !== "string" || input.level2.tool === "") {
      fail("invalid_params", "level2.tool is required");
    }
    let level3Ref = input.level3Ref ?? null;
    if (input.level3 !== undefined) {
      if (this.#level3 === undefined) fail("invalid_params", "no level-3 store configured");
      level3Ref = this.#level3.put(taskId, input.level3);
    }
    const level2: TaskAction["level2"] = { tool: input.level2.tool };
    if (input.level2.target !== undefined) level2.target = input.level2.target;
    if (input.level2.outcome !== undefined) level2.outcome = input.level2.outcome;
    const row: ActionRow = {
      id: this.#newId(),
      task_id: taskId,
      idx,
      tool_call_id: input.toolCallId ?? null,
      level1: normalizeLevel1(input.level1),
      level2: JSON.stringify(level2),
      level3_ref: level3Ref,
      created_at: this.#iso(),
    };
    this.#db.sqlite
      .prepare(
        "INSERT INTO task_actions (id, task_id, idx, tool_call_id, level1, level2, level3_ref, created_at) VALUES (@id, @task_id, @idx, @tool_call_id, @level1, @level2, @level3_ref, @created_at)",
      )
      .run(row);
    return actionFromRow(row);
  }

  #actionEvent(action: TaskAction): ActionEvent {
    return { event: "task.action", payload: { action } };
  }

  // --- TaskEngine ------------------------------------------------------------------------------

  async create(input: CreateTaskInput): Promise<Task> {
    const id = this.#newId();
    const now = this.#iso();
    const event = this.#tx(() => {
      this.#db.sqlite
        .prepare(
          `INSERT INTO tasks (id, thread_id, title, goal, status, created_from, plan, checklist,
            attempt, run_mode, budget, taint, taint_sources, created_at, updated_at)
           VALUES (@id, @thread_id, @title, @goal, 'queued', @created_from, @plan, @checklist,
            0, @run_mode, @budget, @taint, @taint_sources, @now, @now)`,
        )
        .run({
          id,
          thread_id: input.threadId,
          title: input.title,
          goal: input.goal,
          created_from: input.createdFrom,
          plan: json(input.plan ?? null),
          checklist: JSON.stringify(input.checklist ?? []),
          run_mode: input.mode ?? "attended",
          budget: json(input.budget ?? null),
          taint: input.taint === undefined ? null : input.taint ? 1 : 0,
          // The creating turn's sources stay with the task for its whole life (design-08).
          taint_sources: json(input.taintSources),
          now,
        });
      return this.#updated(id);
    });
    this.#emit([event]);
    return event.payload.task;
  }

  async get(taskId: string): Promise<Task | undefined> {
    const row = this.#db.sqlite.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    return row === undefined ? undefined : taskFromRow(row);
  }

  /** The task plus engine-only state (run mode, budget, what it waits on, pending resume items). */
  getRecord(taskId: string): TaskRecord | undefined {
    const row = this.#db.sqlite.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    if (row === undefined) return undefined;
    return {
      task: taskFromRow(row),
      runMode: row.run_mode as RunMode,
      budget: parseJson<TaskBudget>(row.budget),
      awaiting: parseJson<Awaiting>(row.awaiting),
      resume: parseJson<ResumeItem[]>(row.resume) ?? [],
    };
  }

  async list(filter: TaskFilter = {}): Promise<Task[]> {
    return this.listPage({ ...filter, limit: Number.MAX_SAFE_INTEGER }).items;
  }

  /** Most recently updated first (`tasks.list`). */
  listPage(filter: TaskFilter & { cursor?: string; limit?: number } = {}): Page<Task> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== undefined) {
      if (filter.status.length === 0) return { items: [], nextCursor: null };
      where.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
      params.push(...filter.status);
    }
    if (filter.threadId !== undefined) {
      where.push("thread_id = ?");
      params.push(filter.threadId);
    }
    const after = decodeCursor(filter.cursor, 2);
    if (after !== undefined) {
      where.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
      params.push(after[0], after[0], after[1]);
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 1_000_000));
    const rows = this.#db.sqlite
      .prepare(
        `SELECT * FROM tasks ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as TaskRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(taskFromRow),
      nextCursor:
        rows.length > limit && last !== undefined ? encodeCursor([last.updated_at, last.id]) : null,
    };
  }

  /**
   * With `options.lease`, the write happens only while that lease is live (a worker settling
   * its turn), so a pause or cancel committed meanwhile is never overwritten. `running` is
   * reachable only through `claim`.
   */
  async updateStatus(
    taskId: string,
    status: TaskStatus,
    patch: { summary?: string; outcome?: JsonObject } = {},
    options: { lease?: TaskLease } = {},
  ): Promise<Task> {
    const event = this.#tx(() => {
      const row = this.#row(taskId);
      if (status === "running" && row.status !== "running") {
        if (isTerminal(row.status as TaskStatus))
          fail("conflict", `task ${taskId} is ${row.status}`);
        fail("invalid_params", "tasks start running only through claim");
      }
      this.#assertLease(taskId, options.lease);
      const extra: Record<string, unknown> = {};
      if (patch.summary !== undefined) extra.summary = patch.summary;
      if (patch.outcome !== undefined) extra.outcome = JSON.stringify(patch.outcome);
      this.#setStatus(row, status, extra);
      return this.#updated(taskId);
    });
    this.#emit([event]);
    return event.payload.task;
  }

  async claim(owner: string, options: ClaimOptions): Promise<TaskLease | undefined> {
    if (!(options.leaseMs > 0)) fail("invalid_params", "leaseMs must be positive");
    const result = this.#tx(() => {
      const now = this.#iso();
      const claimable = "(status = 'queued' OR (status = 'running' AND lease_until <= @now))";
      const row = (
        options.taskId === undefined
          ? this.#db.sqlite
              .prepare(`SELECT * FROM tasks WHERE ${claimable} ORDER BY created_at, id LIMIT 1`)
              .get({ now })
          : this.#db.sqlite
              .prepare(`SELECT * FROM tasks WHERE id = @id AND ${claimable}`)
              .get({ now, id: options.taskId })
      ) as TaskRow | undefined;
      if (row === undefined) {
        if (options.taskId !== undefined) this.#row(options.taskId);
        return undefined;
      }
      const events: PendingEvent[] = [];
      if (row.status === "running") {
        // Expired lease: the previous worker crashed or slept. Unsafe in-flight steps become
        // uncertain and are never replayed; safe ones run again.
        const uncertain = this.#settleInFlight(row.id, "pending");
        const resume = this.#pushResume(row, {
          kind: "recovered",
          previousOwner: row.lease_owner,
          uncertainStepIds: uncertain,
        });
        this.#patch(row.id, { resume });
        events.push(
          this.#actionEvent(
            this.#insertAction(row.id, {
              level1:
                uncertain.length === 0
                  ? "Recovered after the previous worker stopped"
                  : `Recovered after the previous worker stopped; ${uncertain.length} step(s) need reconciliation`,
              level2: {
                tool: "task.recover",
                outcome: uncertain.length === 0 ? "ok" : "uncertain",
              },
            }),
          ),
        );
      }
      const until = this.clock.now() + options.leaseMs;
      const token = this.#newId();
      this.#patch(row.id, {
        status: "running",
        attempt: row.attempt + 1,
        lease_owner: owner,
        lease_until: new Date(until).toISOString(),
        lease_token: token,
        awaiting: null,
        updated_at: now,
      });
      events.push(this.#updated(row.id));
      return { lease: { taskId: row.id, owner, until, token }, events };
    });
    if (result === undefined) return undefined;
    this.#emit(result.events);
    return result.lease;
  }

  #checkLease(lease: TaskLease): TaskRow {
    const row = this.#row(lease.taskId);
    if (row.lease_token !== lease.token || row.status !== "running") {
      return fail("conflict", "lease lost");
    }
    if (row.lease_until !== null && row.lease_until <= this.#iso()) {
      return fail("conflict", "lease expired");
    }
    return row;
  }

  /** Inside a transaction: `lease` must still be the task's live lease. */
  #assertLease(taskId: string, lease: TaskLease | undefined): void {
    if (lease === undefined) return;
    if (lease.taskId !== taskId) fail("conflict", "lease is for another task");
    this.#checkLease(lease);
  }

  async renew(lease: TaskLease, leaseMs: number): Promise<TaskLease> {
    return this.#tx(() => {
      this.#checkLease(lease);
      const until = this.clock.now() + leaseMs;
      this.#patch(lease.taskId, { lease_until: new Date(until).toISOString() });
      return { ...lease, until };
    });
  }

  async release(lease: TaskLease): Promise<void> {
    const event = this.#tx(() => {
      const row = this.#db.sqlite.prepare("SELECT * FROM tasks WHERE id = ?").get(lease.taskId) as
        | TaskRow
        | undefined;
      if (row === undefined || row.lease_token !== lease.token) return undefined;
      this.#patch(row.id, {
        lease_owner: null,
        lease_until: null,
        lease_token: null,
        updated_at: this.#iso(),
        ...(row.status === "running" ? { status: "queued" } : {}),
      });
      return this.#updated(row.id);
    });
    this.#emit([event]);
  }

  /** What the next turn must be told; requires a live lease. Cleared by `ackResume`. */
  readResume(lease: TaskLease): ResumeItem[] {
    const row = this.#checkLease(lease);
    return parseJson<ResumeItem[]>(row.resume) ?? [];
  }

  /**
   * Drops the first `count` resume items once a turn has received them (items added since are
   * kept), so a turn that fails to start, or a crash before it does, loses nothing.
   */
  ackResume(lease: TaskLease, count: number): void {
    if (count <= 0) return;
    this.#tx(() => {
      const row = this.#checkLease(lease);
      const list = parseJson<ResumeItem[]>(row.resume) ?? [];
      this.#patch(row.id, { resume: JSON.stringify(list.slice(count)) });
    });
  }

  async checkpoint(taskId: string, input: CheckpointInput): Promise<TaskCheckpoint> {
    return this.#tx(() => {
      this.#row(taskId);
      const now = this.#iso();
      const existing = this.#db.sqlite
        .prepare("SELECT * FROM task_checkpoints WHERE task_id = ? AND step_id = ?")
        .get(taskId, input.stepId) as CheckpointRow | undefined;
      if (existing !== undefined) {
        const next: CheckpointRow = {
          ...existing,
          status: input.status,
          replay_safe: input.replaySafe ? 1 : 0,
          payload: input.payload === undefined ? existing.payload : json(input.payload),
          receipt_id: input.receiptId === undefined ? existing.receipt_id : input.receiptId,
          updated_at: now,
        };
        this.#db.sqlite
          .prepare(
            "UPDATE task_checkpoints SET status = @status, replay_safe = @replay_safe, payload = @payload, receipt_id = @receipt_id, updated_at = @updated_at WHERE id = @id",
          )
          .run(next);
        this.#patch(taskId, { current_step_id: input.stepId, updated_at: now });
        return checkpointFromRow(next);
      }
      const idx = (
        this.#db.sqlite
          .prepare("SELECT COALESCE(MAX(idx) + 1, 0) AS n FROM task_checkpoints WHERE task_id = ?")
          .get(taskId) as { n: number }
      ).n;
      const row: CheckpointRow = {
        id: this.#newId(),
        task_id: taskId,
        step_id: input.stepId,
        idx,
        replay_safe: input.replaySafe ? 1 : 0,
        status: input.status,
        payload: json(input.payload ?? null),
        receipt_id: input.receiptId ?? null,
        created_at: now,
        updated_at: now,
      };
      this.#db.sqlite
        .prepare(
          "INSERT INTO task_checkpoints (id, task_id, step_id, idx, replay_safe, status, payload, receipt_id, created_at, updated_at) VALUES (@id, @task_id, @step_id, @idx, @replay_safe, @status, @payload, @receipt_id, @created_at, @updated_at)",
        )
        .run(row);
      this.#patch(taskId, { current_step_id: input.stepId, updated_at: now });
      return checkpointFromRow(row);
    });
  }

  async checkpoints(taskId: string): Promise<TaskCheckpoint[]> {
    return (
      this.#db.sqlite
        .prepare("SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY idx")
        .all(taskId) as CheckpointRow[]
    ).map(checkpointFromRow);
  }

  async addAction(taskId: string, input: ActionInput): Promise<TaskAction> {
    const action = this.#tx(() => {
      this.#row(taskId);
      return this.#insertAction(taskId, input);
    });
    this.#emit([this.#actionEvent(action)]);
    return action;
  }

  async actions(taskId: string): Promise<TaskAction[]> {
    return this.actionsPage(taskId, { limit: Number.MAX_SAFE_INTEGER }).items;
  }

  /** Activity lines in order (`tasks.actions`). */
  actionsPage(taskId: string, page: { cursor?: string; limit?: number } = {}): Page<TaskAction> {
    const after = decodeCursor(page.cursor, 1)?.[0] ?? -1;
    const limit = Math.max(1, Math.min(page.limit ?? 100, 1_000_000));
    const rows = this.#db.sqlite
      .prepare("SELECT * FROM task_actions WHERE task_id = ? AND idx > ? ORDER BY idx LIMIT ?")
      .all(taskId, after, limit + 1) as ActionRow[];
    const items = rows.slice(0, limit).map(actionFromRow);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last !== undefined ? encodeCursor([last.idx]) : null,
    };
  }

  async requestInput(
    taskId: string,
    questions: Question[],
    options: { id?: string; lease?: TaskLease } = {},
  ): Promise<InputRequest> {
    if (questions.length < 1 || questions.length > 4) fail("invalid_params", "1–4 questions");
    for (const q of questions) {
      if (!questionValidator.check(q)) {
        fail("invalid_params", `invalid question: ${questionValidator.errors(q).join("; ")}`);
      }
    }
    const result = this.#tx(() => {
      const row = this.#row(taskId);
      this.#assertLease(taskId, options.lease);
      if (options.id !== undefined) {
        const existing = this.#db.sqlite
          .prepare("SELECT * FROM input_requests WHERE id = ?")
          .get(options.id) as InputRow | undefined;
        if (existing !== undefined) {
          if (existing.task_id !== taskId)
            fail("conflict", "input request belongs to another task");
          if (existing.status === "open") {
            this.#setStatus(row, "awaiting_input", {
              awaiting: JSON.stringify({
                kind: "input",
                inputRequestId: existing.id,
                since: this.#iso(),
              } satisfies Awaiting),
            });
          }
          return { req: inputFromRow(existing), event: this.#updated(taskId) };
        }
      }
      const now = this.#iso();
      const ir: InputRow = {
        id: options.id ?? this.#newId(),
        task_id: taskId,
        thread_id: row.thread_id,
        question: JSON.stringify(questions),
        status: "open",
        answer: null,
        created_at: now,
        answered_at: null,
        answered_by_device_id: null,
      };
      this.#db.sqlite
        .prepare(
          "INSERT INTO input_requests (id, task_id, thread_id, question, status, answer, created_at, answered_at, answered_by_device_id) VALUES (@id, @task_id, @thread_id, @question, @status, @answer, @created_at, @answered_at, @answered_by_device_id)",
        )
        .run(ir);
      this.#setStatus(row, "awaiting_input", {
        awaiting: JSON.stringify({
          kind: "input",
          inputRequestId: ir.id,
          since: now,
        } satisfies Awaiting),
      });
      return { req: inputFromRow(ir), event: this.#updated(taskId) };
    });
    this.#emit([result.event]);
    return result.req;
  }

  async answerInput(
    inputRequestId: string,
    answer: Record<string, string | string[]>,
    options: { deviceId?: string } = {},
  ): Promise<InputRequest> {
    const result = this.#tx(() => {
      const ir = this.#db.sqlite
        .prepare("SELECT * FROM input_requests WHERE id = ?")
        .get(inputRequestId) as InputRow | undefined;
      if (ir === undefined) return fail("not_found", "input request not found");
      if (ir.status !== "open") return fail("conflict", `input request is ${ir.status}`);
      const next: InputRow = {
        ...ir,
        status: "answered",
        answer: JSON.stringify(answer),
        answered_at: this.#iso(),
        answered_by_device_id: options.deviceId ?? null,
      };
      this.#db.sqlite
        .prepare(
          "UPDATE input_requests SET status = @status, answer = @answer, answered_at = @answered_at, answered_by_device_id = @answered_by_device_id WHERE id = @id",
        )
        .run(next);
      let event: PendingEvent | undefined;
      if (ir.task_id !== null) {
        const row = this.#row(ir.task_id);
        const resume = this.#pushResume(row, {
          kind: "input_answered",
          inputRequestId,
          questions: parseJson<Question[]>(ir.question) ?? [],
          answer,
        });
        const stillOpen = this.#db.sqlite
          .prepare("SELECT COUNT(*) AS n FROM input_requests WHERE task_id = ? AND status = 'open'")
          .get(row.id) as { n: number };
        const clears = stillOpen.n === 0 && parseJson<Awaiting>(row.awaiting)?.kind === "input";
        if (row.status === "awaiting_input" && stillOpen.n === 0) {
          this.#setStatus(row, "queued", { resume, awaiting: null });
        } else {
          // Paused (or not parked): keep the answer; resume() then re-queues the task.
          this.#patch(row.id, { resume, ...(clears ? { awaiting: null } : {}) });
        }
        event = this.#updated(row.id);
      }
      return { req: inputFromRow(next), event };
    });
    this.#emit([result.event]);
    return result.req;
  }

  /** Input requests, oldest first (Upcoming / Activity surface open ones). */
  inputRequests(filter: { taskId?: string; status?: InputRequest["status"] } = {}): InputRequest[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.taskId !== undefined) {
      where.push("task_id = ?");
      params.push(filter.taskId);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
    }
    return (
      this.#db.sqlite
        .prepare(
          `SELECT * FROM input_requests ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`,
        )
        .all(...params) as InputRow[]
    ).map(inputFromRow);
  }

  async pause(taskId: string): Promise<Task> {
    const event = this.#tx(() => {
      const row = this.#row(taskId);
      if (isTerminal(row.status as TaskStatus)) fail("conflict", `task ${taskId} is ${row.status}`);
      if (row.status === "running") this.#settleInFlight(taskId, "pending");
      this.#setStatus(row, "paused");
      return this.#updated(taskId);
    });
    this.#emit([event]);
    return event.payload.task;
  }

  async resume(taskId: string): Promise<Task> {
    const event = this.#tx(() => {
      const row = this.#row(taskId);
      if (row.status !== "paused") fail("conflict", `task is ${row.status}, not paused`);
      const resume = this.#pushResume(row, { kind: "resumed" });
      // A task parked on an open question or approval goes back to waiting on it.
      const awaiting = parseJson<Awaiting>(row.awaiting);
      const to: TaskStatus =
        awaiting?.kind === "input"
          ? "awaiting_input"
          : awaiting?.kind === "approval"
            ? "awaiting_approval"
            : "queued";
      this.#setStatus(row, to, { resume });
      return this.#updated(taskId);
    });
    this.#emit([event]);
    return event.payload.task;
  }

  async cancel(taskId: string, reason?: string): Promise<Task> {
    const events = this.#tx(() => {
      const row = this.#row(taskId);
      const uncertain = this.#settleInFlight(taskId, "failed");
      this.#setStatus(row, "cancelled", reason === undefined ? {} : { summary: reason });
      this.#db.sqlite
        .prepare(
          "UPDATE input_requests SET status = 'cancelled' WHERE task_id = ? AND status = 'open'",
        )
        .run(taskId);
      const out: PendingEvent[] = [];
      if (uncertain.length > 0) {
        out.push(
          this.#actionEvent(
            this.#insertAction(taskId, {
              level1: `Cancelled mid-step; ${uncertain.length} step(s) need reconciliation`,
              level2: { tool: "task.cancel", outcome: "uncertain" },
            }),
          ),
        );
      }
      out.push(this.#updated(taskId));
      return out;
    });
    this.#emit(events);
    return lastTask(events);
  }

  /**
   * `failed` / `cancelled` → `queued`. With `fromStepId`, that step and every later
   * non-uncertain checkpoint go back to `pending`; uncertain steps stay uncertain until
   * `reconcile` (never replayed blindly).
   */
  async retry(taskId: string, options: { fromStepId?: string } = {}): Promise<Task> {
    const event = this.#tx(() => {
      const row = this.#row(taskId);
      if (row.status !== "failed" && row.status !== "cancelled") {
        fail("conflict", `only failed or cancelled tasks can be retried (is ${row.status})`);
      }
      if (options.fromStepId !== undefined) {
        const cp = this.#db.sqlite
          .prepare("SELECT idx FROM task_checkpoints WHERE task_id = ? AND step_id = ?")
          .get(taskId, options.fromStepId) as { idx: number } | undefined;
        if (cp === undefined) fail("not_found", `step ${options.fromStepId} not found`);
        this.#db.sqlite
          .prepare(
            "UPDATE task_checkpoints SET status = 'pending', updated_at = ? WHERE task_id = ? AND idx >= ? AND (status = 'failed' OR (status = 'done' AND replay_safe = 1))",
          )
          .run(this.#iso(), taskId, cp.idx);
      }
      const resume = this.#pushResume(row, {
        kind: "retry",
        fromStepId: options.fromStepId ?? null,
      });
      this.#patch(taskId, {
        status: "queued",
        completed_at: null,
        updated_at: this.#iso(),
        resume,
      });
      return this.#updated(taskId);
    });
    this.#emit([event]);
    return event.payload.task;
  }

  // --- Extensions ------------------------------------------------------------------------------

  /** Parks the task on an approval (architecture §4.5); the worker's watcher resolves it. */
  async parkForApproval(
    taskId: string,
    approval: { approvalId: string; stepId?: string | null },
    options: { lease?: TaskLease } = {},
  ): Promise<Task> {
    const event = this.#tx(() => {
      const row = this.#row(taskId);
      this.#assertLease(taskId, options.lease);
      this.#setStatus(row, "awaiting_approval", {
        awaiting: JSON.stringify({
          kind: "approval",
          approvalId: approval.approvalId,
          stepId: approval.stepId ?? null,
          since: this.#iso(),
        } satisfies Awaiting),
      });
      return this.#updated(taskId);
    });
    this.#emit([event]);
    return event.payload.task;
  }

  /**
   * Applies a decided approval to the task parked on it. Approved or denied → `queued` with the
   * decision in the resume queue. Expired → the step goes back to `pending` and the task is
   * re-queued so the next turn asks again (security §3.7: expiry denies, the Task stays
   * resumable). Invalidated by a restart → stays parked until `rebindApproval`. Returns
   * `undefined` when the task no longer waits on this approval.
   */
  async resolveApproval(
    taskId: string,
    approval: Pick<ApprovalRequest, "id" | "status" | "invalidatedReason">,
  ): Promise<Task | undefined> {
    const events = this.#tx(() => {
      const row = this.#row(taskId);
      const awaiting = parseJson<Awaiting>(row.awaiting);
      if (awaiting?.kind !== "approval" || awaiting.approvalId !== approval.id) return undefined;
      if (approval.status === "pending") return undefined;
      if (approval.status === "invalidated" && approval.invalidatedReason === "gateway_restart") {
        return undefined;
      }
      const out: PendingEvent[] = [];
      const item: ResumeItem = {
        kind: "approval",
        approvalId: approval.id,
        status: approval.status,
        stepId: awaiting.stepId,
      };
      if (approval.invalidatedReason !== undefined) item.reason = approval.invalidatedReason;
      const resume = this.#pushResume(row, item);
      if (approval.status === "expired" && awaiting.stepId !== null) {
        this.#db.sqlite
          .prepare(
            "UPDATE task_checkpoints SET status = 'pending', updated_at = ? WHERE task_id = ? AND step_id = ? AND status != 'uncertain'",
          )
          .run(this.#iso(), taskId, awaiting.stepId);
      }
      const level1 =
        approval.status === "approved"
          ? "Approval granted; resuming"
          : approval.status === "denied"
            ? "Approval denied"
            : approval.status === "expired"
              ? "Approval expired; step re-queued"
              : "Approval invalidated; step re-queued";
      out.push(
        this.#actionEvent(
          this.#insertAction(taskId, {
            level1,
            level2: { tool: "approval", target: approval.id, outcome: approval.status },
          }),
        ),
      );
      if (row.status === "awaiting_approval") {
        this.#setStatus(row, "queued", { resume, awaiting: null });
      } else {
        // Paused while parked: keep the decision for when the task resumes.
        this.#patch(taskId, { resume, awaiting: null, updated_at: this.#iso() });
      }
      out.push(this.#updated(taskId));
      return out;
    });
    if (events === undefined) return undefined;
    this.#emit(events);
    return lastTask(events);
  }

  /** A restart re-issued the approval this task waits on under a new id (security §3.7). */
  async rebindApproval(taskId: string, newApprovalId: string): Promise<boolean> {
    return this.#tx(() => {
      const row = this.#row(taskId);
      const awaiting = parseJson<Awaiting>(row.awaiting);
      if (awaiting?.kind !== "approval") return false;
      this.#patch(taskId, {
        awaiting: JSON.stringify({ ...awaiting, approvalId: newApprovalId } satisfies Awaiting),
      });
      return true;
    });
  }

  /** Tasks parked on an approval, with the id they wait on (boot: re-watch them). */
  parkedOnApprovals(): { taskId: string; approvalId: string }[] {
    const rows = this.#db.sqlite
      .prepare("SELECT id, awaiting FROM tasks WHERE awaiting IS NOT NULL")
      .all() as { id: string; awaiting: string }[];
    const out: { taskId: string; approvalId: string }[] = [];
    for (const r of rows) {
      const a = parseJson<Awaiting>(r.awaiting);
      if (a?.kind === "approval") out.push({ taskId: r.id, approvalId: a.approvalId });
    }
    return out;
  }

  /** Resolves an `uncertain` step after the owner (or a receipt) settled what happened. */
  async reconcile(
    taskId: string,
    stepId: string,
    result: { status: "done" | "failed"; receiptId?: string; note?: string },
  ): Promise<TaskCheckpoint> {
    const out = this.#tx(() => {
      const row = this.#row(taskId);
      const cp = this.#db.sqlite
        .prepare("SELECT * FROM task_checkpoints WHERE task_id = ? AND step_id = ?")
        .get(taskId, stepId) as CheckpointRow | undefined;
      if (cp === undefined) return fail("not_found", `step ${stepId} not found`);
      if (cp.status !== "uncertain") return fail("conflict", `step ${stepId} is ${cp.status}`);
      const next: CheckpointRow = {
        ...cp,
        status: result.status,
        receipt_id: result.receiptId ?? cp.receipt_id,
        updated_at: this.#iso(),
      };
      this.#db.sqlite
        .prepare(
          "UPDATE task_checkpoints SET status = @status, receipt_id = @receipt_id, updated_at = @updated_at WHERE id = @id",
        )
        .run(next);
      const item: ResumeItem = { kind: "reconciled", stepId, status: result.status };
      if (result.note !== undefined) item.note = result.note;
      this.#patch(taskId, { resume: this.#pushResume(row, item), updated_at: this.#iso() });
      const action = this.#insertAction(taskId, {
        level1: `Reconciled ${stepId}: ${result.status}`,
        level2: { tool: "task.reconcile", target: stepId, outcome: result.status },
      });
      return {
        cp: checkpointFromRow(next),
        events: [this.#actionEvent(action), this.#updated(taskId)],
      };
    });
    this.#emit(out.events);
    return out.cp;
  }

  /** The task owns its browser session and sandbox (D7); closing a pane keeps them. */
  async attachResources(
    taskId: string,
    resources: { browserSessionId?: string | null; sandboxId?: string | null },
  ): Promise<Task> {
    const event = this.#tx(() => {
      this.#row(taskId);
      const cols: Record<string, unknown> = { updated_at: this.#iso() };
      if (resources.browserSessionId !== undefined) {
        cols.browser_session_id = resources.browserSessionId;
      }
      if (resources.sandboxId !== undefined) cols.sandbox_id = resources.sandboxId;
      this.#patch(taskId, cols);
      return this.#updated(taskId);
    });
    this.#emit([event]);
    return event.payload.task;
  }

  /** Plan / checklist updates for the Tasks pane (D5). */
  async updatePlan(
    taskId: string,
    patch: { plan?: TaskPlan | null; checklist?: ChecklistItem[] },
  ): Promise<Task> {
    const event = this.#tx(() => {
      this.#row(taskId);
      const cols: Record<string, unknown> = { updated_at: this.#iso() };
      if (patch.plan !== undefined) cols.plan = json(patch.plan);
      if (patch.checklist !== undefined) cols.checklist = JSON.stringify(patch.checklist);
      this.#patch(taskId, cols);
      return this.#updated(taskId);
    });
    this.#emit([event]);
    return event.payload.task;
  }

  /**
   * Boot / wake sweep: every `running` task whose lease expired goes back to `queued` with its
   * in-flight unsafe steps marked `uncertain`. Returns the recovered task ids.
   */
  async recoverExpired(): Promise<string[]> {
    const ids = (
      this.#db.sqlite
        .prepare("SELECT id FROM tasks WHERE status = 'running' AND lease_until <= ?")
        .all(this.#iso()) as { id: string }[]
    ).map((r) => r.id);
    const recovered: string[] = [];
    for (const id of ids) {
      const events = this.#tx(() => {
        const row = this.#row(id);
        if (row.status !== "running" || row.lease_until === null || row.lease_until > this.#iso()) {
          return undefined;
        }
        const uncertain = this.#settleInFlight(id, "pending");
        const resume = this.#pushResume(row, {
          kind: "recovered",
          previousOwner: row.lease_owner,
          uncertainStepIds: uncertain,
        });
        this.#setStatus(row, "queued", { resume });
        const action = this.#insertAction(id, {
          level1:
            uncertain.length === 0
              ? "Recovered after a restart"
              : `Recovered after a restart; ${uncertain.length} step(s) need reconciliation`,
          level2: { tool: "task.recover", outcome: uncertain.length === 0 ? "ok" : "uncertain" },
        });
        return [this.#actionEvent(action), this.#updated(id)];
      });
      if (events !== undefined) {
        recovered.push(id);
        this.#emit(events);
      }
    }
    return recovered;
  }
}
