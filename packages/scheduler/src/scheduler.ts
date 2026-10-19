import type { PsycheDb } from "@psyche/db";
import {
  type Automation,
  type AutomationInput,
  type AutomationPatch,
  type AutomationRun,
  type Clock,
  type Notifier,
  PsycheError,
  type ScheduledRun,
  type Scheduler,
  type UpcomingItem,
  type WatchConfig,
} from "@psyche/protocol";
import type { Timers } from "@psyche/tasks";
import { systemTimers } from "@psyche/tasks";
import { buildUnattendedPrompt } from "./prompt.ts";
import {
  type AutomationRow,
  automationFromRow,
  type RunRow,
  runFromRow,
  type WatchRow,
} from "./rows.ts";
import { parseSchedule, type Schedule } from "./schedule.ts";
import type {
  Deliverer,
  OpenInputRequests,
  RunLauncher,
  RunResult,
  SchedulerEvent,
  SchedulerEventListener,
  SessionResolver,
  WatchFetch,
} from "./types.ts";
import { evaluateWatch } from "./watch.ts";

export interface SqliteSchedulerOptions {
  db: PsycheDb;
  clock: Clock;
  timers?: Timers;
  newId?: () => string;
  nextStateVersion?: () => number;
  launcher?: RunLauncher;
  sessions?: SessionResolver;
  deliverer?: Deliverer;
  notifier?: Notifier;
  watchFetch?: WatchFetch;
  openInputRequests?: OpenInputRequests;
  /** Used when an automation is created without a timezone. */
  defaultTimezone?: string;
  /** The host timer never sleeps longer than this, so clock jumps are noticed. Default 5 min. */
  maxTimerMs?: number;
  /** Watch failure backoff cap. Default 24 h. */
  maxBackoffMs?: number;
  onError?: (error: unknown) => void;
}

/** More missed ticks than this are still one run; the count stops here. */
export const MAX_COALESCE = 100_000;
const SUMMARY_MAX = 4_000;
const SESSION_TARGET = /^(main|isolated|named:[A-Za-z0-9_.:-]{1,64})$/;

type Pending = Omit<SchedulerEvent, "stateVersion">;

export type CreateAutomationInput = Omit<
  AutomationInput,
  "timezone" | "sessionTarget" | "delivery" | "scratch" | "enabled"
> &
  Partial<
    Pick<AutomationInput, "timezone" | "sessionTarget" | "delivery" | "scratch" | "enabled">
  > & {
    /** System-owned (the heartbeat). */
    system?: boolean;
  };

function bad(message: string): never {
  throw new PsycheError("invalid_params", message);
}

function validateWebhook(url: string | undefined): void {
  if (url === undefined) return;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return bad("delivery.webhook must be a URL");
  }
  if (u.protocol !== "https:") bad("delivery.webhook must use https");
  if (u.username !== "" || u.password !== "") bad("delivery.webhook must not carry credentials");
}

/**
 * SQLite scheduler (architecture §4.11; data model §8). Durable `next_run_at`; one host timer
 * armed for the earliest due automation; every tick (timer, `wake()` after sleep, or a manual
 * call) folds all missed ticks of an automation into one run. Runs are launched through a
 * `RunLauncher` with the unattended-run contract; watches run without the agent.
 */
export class SqliteScheduler implements Scheduler {
  readonly clock: Clock;
  readonly #db: PsycheDb;
  readonly #o: SqliteSchedulerOptions;
  readonly #timers: Timers;
  readonly #newId: () => string;
  readonly #nextStateVersion: () => number;
  readonly #listeners = new Set<SchedulerEventListener>();
  readonly #inflight = new Set<Promise<void>>();
  #localVersion = 0;
  #timer: unknown;
  #started = false;

  constructor(options: SqliteSchedulerOptions) {
    this.#o = options;
    this.#db = options.db;
    this.clock = options.clock;
    this.#timers = options.timers ?? systemTimers;
    this.#newId = options.newId ?? options.db.newId;
    this.#nextStateVersion = options.nextStateVersion ?? (() => ++this.#localVersion);
  }

  subscribe(listener: SchedulerEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // --- internals --------------------------------------------------------------------------------

  #iso(ms: number = this.clock.now()): string {
    return new Date(ms).toISOString();
  }

  #emit(events: Pending[]): void {
    for (const e of events) {
      const full = { ...e, stateVersion: this.#nextStateVersion() } as SchedulerEvent;
      for (const l of this.#listeners) {
        try {
          l(full);
        } catch {
          // listeners never undo a committed change
        }
      }
    }
  }

  #error(e: unknown): void {
    this.#o.onError?.(e);
  }

  #tx<T>(fn: () => T): T {
    return this.#db.sqlite.transaction(fn).immediate();
  }

  #rowOrUndefined(id: string): AutomationRow | undefined {
    return this.#db.sqlite.prepare("SELECT * FROM automations WHERE id = ?").get(id) as
      | AutomationRow
      | undefined;
  }

  #row(id: string): AutomationRow {
    const row = this.#rowOrUndefined(id);
    if (row === undefined) throw new PsycheError("not_found", `automation ${id} not found`);
    return row;
  }

  #watchRow(automationId: string): WatchRow | undefined {
    return this.#db.sqlite
      .prepare("SELECT * FROM watches WHERE automation_id = ?")
      .get(automationId) as WatchRow | undefined;
  }

  #automation(id: string): Automation {
    return automationFromRow(this.#row(id), this.#watchRow(id));
  }

  #schedule(row: Pick<AutomationRow, "kind" | "schedule" | "timezone">): Schedule {
    return parseSchedule(row.kind as Automation["kind"], row.schedule, row.timezone);
  }

  #updatedEvent(id: string): Pending {
    return { event: "automation.updated", payload: { automation: this.#automation(id) } };
  }

  #validate(a: {
    kind: Automation["kind"];
    schedule: string;
    timezone: string;
    sessionTarget: string;
    delivery: Automation["delivery"];
    watch?: WatchConfig | undefined;
  }): Schedule {
    const schedule = parseSchedule(a.kind, a.schedule, a.timezone);
    if (!SESSION_TARGET.test(a.sessionTarget)) {
      bad("sessionTarget must be main, isolated or named:<id>");
    }
    validateWebhook(a.delivery.webhook);
    if (a.kind === "watch") {
      if (a.watch === undefined) bad("a watch automation needs `watch`");
      try {
        const u = new URL(a.watch.url);
        if (u.protocol !== "https:" && u.protocol !== "http:") bad("watch.url must be http(s)");
      } catch (e) {
        if (e instanceof PsycheError) throw e;
        bad("watch.url must be a URL");
      }
      if (a.watch.check === "text_present" && (a.watch.text ?? a.watch.selector) === undefined) {
        bad("text_present needs `text` or `selector`");
      }
      if (
        (a.watch.check === "price_below" || a.watch.check === "price_above") &&
        typeof a.watch.threshold !== "number"
      ) {
        bad(`${a.watch.check} needs a numeric threshold`);
      }
      if (a.watch.selector !== undefined) {
        try {
          new RegExp(a.watch.selector);
        } catch {
          bad("watch.selector must be a valid regular expression");
        }
      }
    } else if (a.watch !== undefined) {
      bad("only watch automations take `watch`");
    }
    return schedule;
  }

  #nextIso(schedule: Schedule, enabled: boolean, after: number): string | null {
    if (!enabled) return null;
    const t = schedule.next(after);
    return t === undefined ? null : this.#iso(t);
  }

  #upsertWatch(automationId: string, watch: WatchConfig, reset: boolean): void {
    const now = this.#iso();
    const existing = this.#watchRow(automationId);
    const threshold = JSON.stringify({
      ...(watch.threshold === undefined ? {} : { threshold: watch.threshold }),
      ...(watch.text === undefined ? {} : { text: watch.text }),
    });
    if (existing === undefined) {
      this.#db.sqlite
        .prepare(
          `INSERT INTO watches (id, automation_id, url, kind, selector, threshold, failures, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          this.#newId(),
          automationId,
          watch.url,
          watch.check,
          watch.selector ?? null,
          threshold,
          now,
          now,
        );
      return;
    }
    this.#db.sqlite
      .prepare(
        `UPDATE watches SET url = ?, kind = ?, selector = ?, threshold = ?, updated_at = ?
         ${reset ? ", last_value = NULL, alerted_value = NULL, failures = 0" : ""} WHERE automation_id = ?`,
      )
      .run(watch.url, watch.check, watch.selector ?? null, threshold, now, automationId);
  }

  // --- Scheduler -------------------------------------------------------------------------------

  async create(input: CreateAutomationInput): Promise<Automation> {
    const a = {
      ...input,
      timezone: input.timezone ?? this.#o.defaultTimezone ?? "UTC",
      sessionTarget: input.sessionTarget ?? "isolated",
      delivery: input.delivery ?? {},
      scratch: input.scratch ?? null,
      enabled: input.enabled ?? true,
    };
    if (a.title.trim() === "") bad("title is required");
    const schedule = this.#validate(a);
    const id = this.#newId();
    const now = this.clock.now();
    const event = this.#tx(() => {
      this.#db.sqlite
        .prepare(
          `INSERT INTO automations (id, kind, title, schedule, timezone, session_target, delivery,
             prompt, scratch, enabled, light_context, system, next_run_at, created_at, updated_at)
           VALUES (@id, @kind, @title, @schedule, @timezone, @session_target, @delivery, @prompt,
             @scratch, @enabled, @light_context, @system, @next_run_at, @now, @now)`,
        )
        .run({
          id,
          kind: a.kind,
          title: a.title,
          schedule: a.schedule.trim(),
          timezone: a.timezone,
          session_target: a.sessionTarget,
          delivery: JSON.stringify(a.delivery),
          prompt: a.prompt,
          scratch: a.scratch,
          enabled: a.enabled ? 1 : 0,
          light_context: a.lightContext === undefined ? null : a.lightContext ? 1 : 0,
          system: input.system === true ? 1 : 0,
          next_run_at: this.#nextIso(schedule, a.enabled, now),
          now: this.#iso(now),
        });
      if (a.watch !== undefined) this.#upsertWatch(id, a.watch, false);
      return this.#updatedEvent(id);
    });
    this.#emit([event]);
    this.#arm();
    return this.#automation(id);
  }

  async get(id: string): Promise<Automation | undefined> {
    const row = this.#rowOrUndefined(id);
    return row === undefined ? undefined : automationFromRow(row, this.#watchRow(id));
  }

  async list(filter: { kind?: Automation["kind"] } = {}): Promise<Automation[]> {
    const rows = (
      filter.kind === undefined
        ? this.#db.sqlite.prepare("SELECT * FROM automations ORDER BY created_at, id").all()
        : this.#db.sqlite
            .prepare("SELECT * FROM automations WHERE kind = ? ORDER BY created_at, id")
            .all(filter.kind)
    ) as AutomationRow[];
    return rows.map((r) => automationFromRow(r, this.#watchRow(r.id)));
  }

  async update(id: string, patch: AutomationPatch): Promise<Automation> {
    const event = this.#tx(() => {
      const current = this.#automation(id);
      const next = { ...current, ...patch };
      if (patch.kind !== undefined && patch.kind !== current.kind) bad("kind cannot change");
      const schedule = this.#validate(next);
      const rescheduled =
        patch.schedule !== undefined ||
        patch.timezone !== undefined ||
        (patch.enabled !== undefined && patch.enabled !== current.enabled);
      const now = this.clock.now();
      this.#db.sqlite
        .prepare(
          `UPDATE automations SET title = @title, schedule = @schedule, timezone = @timezone,
             session_target = @session_target, delivery = @delivery, prompt = @prompt,
             scratch = @scratch, enabled = @enabled, light_context = @light_context,
             next_run_at = @next_run_at, updated_at = @now WHERE id = @id`,
        )
        .run({
          id,
          title: next.title,
          schedule: next.schedule.trim(),
          timezone: next.timezone,
          session_target: next.sessionTarget,
          delivery: JSON.stringify(next.delivery),
          prompt: next.prompt,
          scratch: next.scratch,
          enabled: next.enabled ? 1 : 0,
          light_context: next.lightContext === undefined ? null : next.lightContext ? 1 : 0,
          next_run_at: rescheduled
            ? this.#nextIso(schedule, next.enabled, now)
            : next.enabled
              ? current.nextRunAt
              : null,
          now: this.#iso(now),
        });
      if (patch.watch !== undefined) {
        const w = current.watch;
        const reset =
          w === undefined ||
          w.url !== patch.watch.url ||
          w.check !== patch.watch.check ||
          w.selector !== patch.watch.selector;
        this.#upsertWatch(id, patch.watch, reset);
      }
      return this.#updatedEvent(id);
    });
    this.#emit([event]);
    this.#arm();
    return this.#automation(id);
  }

  /** The per-job scratch note the agent keeps between runs. */
  async setScratch(id: string, scratch: string | null): Promise<Automation> {
    return this.update(id, { scratch });
  }

  async remove(id: string): Promise<void> {
    const automation = { ...this.#automation(id), enabled: false, nextRunAt: null };
    this.#db.sqlite.prepare("DELETE FROM automations WHERE id = ?").run(id);
    this.#emit([{ event: "automation.updated", payload: { automation } }]);
    this.#arm();
  }

  async nextRuns(id: string, count: number, from?: number): Promise<number[]> {
    const schedule = this.#schedule(this.#row(id));
    const out: number[] = [];
    let t = from ?? this.clock.now();
    for (let i = 0; i < count; i += 1) {
      const n = schedule.next(t);
      if (n === undefined) break;
      out.push(n);
      t = n;
    }
    return out;
  }

  /**
   * Fire everything due at `now`: one run per automation, however many ticks were missed
   * (catch-up after sleep). A run whose previous run is still going is recorded `skipped`.
   */
  async tick(now: number = this.clock.now()): Promise<ScheduledRun[]> {
    const nowIso = this.#iso(now);
    const fired = this.#tx(() => {
      const rows = this.#db.sqlite
        .prepare(
          "SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id",
        )
        .all(nowIso) as AutomationRow[];
      const out: { run: RunRow; scheduled: ScheduledRun; skipped: boolean }[] = [];
      for (const row of rows) {
        let schedule: Schedule;
        try {
          schedule = this.#schedule(row);
        } catch {
          // A schedule that no longer parses (e.g. a removed timezone) is paused, not retried.
          this.#db.sqlite
            .prepare(
              "UPDATE automations SET enabled = 0, next_run_at = NULL, last_status = 'failed', updated_at = ? WHERE id = ?",
            )
            .run(nowIso, row.id);
          continue;
        }
        let latest = Date.parse(row.next_run_at as string);
        let coalesced = 1;
        let next = schedule.next(latest);
        while (next !== undefined && next <= now && coalesced < MAX_COALESCE) {
          coalesced += 1;
          latest = next;
          next = schedule.next(next);
        }
        if (next !== undefined && next <= now) next = schedule.next(now);
        const busy = this.#db.sqlite
          .prepare(
            "SELECT 1 FROM automation_runs WHERE automation_id = ? AND status = 'running' LIMIT 1",
          )
          .get(row.id);
        const run: RunRow = {
          id: this.#newId(),
          automation_id: row.id,
          thread_id: null,
          task_id: null,
          trigger: "schedule",
          scheduled_for: this.#iso(latest),
          coalesced,
          started_at: nowIso,
          ended_at: busy === undefined ? null : nowIso,
          status: busy === undefined ? "running" : "skipped",
          summary: busy === undefined ? null : "The previous run is still running",
          notification_id: null,
          created_at: nowIso,
        };
        this.#insertRun(run);
        this.#db.sqlite
          .prepare(
            "UPDATE automations SET next_run_at = ?, last_run_at = ?, last_status = ?, updated_at = ? WHERE id = ?",
          )
          .run(next === undefined ? null : this.#iso(next), nowIso, run.status, nowIso, row.id);
        out.push({
          run,
          skipped: busy !== undefined,
          scheduled: { automationId: row.id, scheduledFor: latest, coalesced, trigger: "schedule" },
        });
      }
      return out;
    });
    const events: Pending[] = [];
    for (const f of fired) {
      events.push({
        event: f.skipped ? "automation.run.finished" : "automation.run.started",
        payload: { run: runFromRow(f.run) },
      });
      events.push(this.#updatedEvent(f.run.automation_id));
    }
    this.#emit(events);
    for (const f of fired) if (!f.skipped) this.#track(this.#dispatch(f.run.id));
    this.#arm();
    return fired.filter((f) => !f.skipped).map((f) => f.scheduled);
  }

  async runNow(id: string): Promise<ScheduledRun> {
    return (await this.trigger(id)).scheduled;
  }

  /** Manual run (`automations.run`): resolves once the run is launched, with its task id. */
  async trigger(
    id: string,
  ): Promise<{ scheduled: ScheduledRun; run: AutomationRun; taskId: string | null }> {
    const now = this.clock.now();
    const nowIso = this.#iso(now);
    const run = this.#tx(() => {
      this.#row(id);
      const r: RunRow = {
        id: this.#newId(),
        automation_id: id,
        thread_id: null,
        task_id: null,
        trigger: "manual",
        scheduled_for: nowIso,
        coalesced: 1,
        started_at: nowIso,
        ended_at: null,
        status: "running",
        summary: null,
        notification_id: null,
        created_at: nowIso,
      };
      this.#insertRun(r);
      this.#db.sqlite
        .prepare(
          "UPDATE automations SET last_run_at = ?, last_status = 'running', updated_at = ? WHERE id = ?",
        )
        .run(nowIso, nowIso, id);
      return r;
    });
    this.#emit([
      { event: "automation.run.started", payload: { run: runFromRow(run) } },
      this.#updatedEvent(id),
    ]);
    let launched!: (taskId: string | null) => void;
    const taskId = new Promise<string | null>((r) => {
      launched = r;
    });
    this.#track(this.#dispatch(run.id, launched));
    return {
      scheduled: { automationId: id, scheduledFor: now, coalesced: 1, trigger: "manual" },
      run: runFromRow(run),
      taskId: await taskId,
    };
  }

  // --- runs ------------------------------------------------------------------------------------

  #insertRun(r: RunRow): void {
    this.#db.sqlite
      .prepare(
        `INSERT INTO automation_runs (id, automation_id, thread_id, task_id, trigger, scheduled_for,
           coalesced, started_at, ended_at, status, summary, notification_id, created_at)
         VALUES (@id, @automation_id, @thread_id, @task_id, @trigger, @scheduled_for, @coalesced,
           @started_at, @ended_at, @status, @summary, @notification_id, @created_at)`,
      )
      .run(r);
  }

  #runRow(runId: string): RunRow {
    const r = this.#db.sqlite.prepare("SELECT * FROM automation_runs WHERE id = ?").get(runId) as
      | RunRow
      | undefined;
    if (r === undefined) throw new PsycheError("not_found", `run ${runId} not found`);
    return r;
  }

  #track(p: Promise<void>): void {
    const tracked = p.catch((e) => this.#error(e)).finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
  }

  /** Resolves when every launched run has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.all([...this.#inflight]);
  }

  async #dispatch(runId: string, launched?: (taskId: string | null) => void): Promise<void> {
    const run = this.#runRow(runId);
    const automation = this.#automation(run.automation_id);
    try {
      if (automation.kind === "watch") {
        launched?.(null);
        await this.#runWatch(automation, run);
        return;
      }
      const { launcher, sessions } = this.#o;
      if (launcher === undefined || sessions === undefined) {
        launched?.(null);
        await this.#finish(runId, { status: "failed", summary: "No run launcher is configured" });
        return;
      }
      const threadId = await sessions.resolve(automation.sessionTarget, { automation, runId });
      this.#db.sqlite
        .prepare("UPDATE automation_runs SET thread_id = ? WHERE id = ?")
        .run(threadId, runId);
      const current = runFromRow(this.#runRow(runId));
      const handle = await launcher.launch({
        automation,
        run: current,
        threadId,
        prompt: buildUnattendedPrompt(automation, current),
        lightContext: automation.lightContext === true,
      });
      if (handle.taskId !== undefined) {
        this.#db.sqlite
          .prepare("UPDATE automation_runs SET task_id = ? WHERE id = ?")
          .run(handle.taskId, runId);
      }
      launched?.(handle.taskId ?? null);
      await this.#finish(runId, await handle.result);
    } catch (e) {
      launched?.(null);
      await this.#finish(runId, {
        status: "failed",
        summary: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async #finish(runId: string, result: RunResult): Promise<void> {
    const row = this.#runRow(runId);
    if (row.status !== "running") return;
    const automation = this.#rowOrUndefined(row.automation_id);
    let notificationId: string | null = null;
    if (automation !== undefined) {
      const a = automationFromRow(automation, this.#watchRow(automation.id));
      const finished = runFromRow({ ...row, status: result.status, summary: result.summary });
      try {
        if (result.status === "done" && a.kind !== "watch") {
          notificationId =
            (await this.#o.deliverer?.deliver(a, finished, result))?.notificationId ?? null;
        } else if (result.status === "failed" && this.#o.notifier !== undefined) {
          const n = await this.#o.notifier.notify({
            kind: "task_failed",
            title: `${a.title} failed`,
            body: result.summary ?? "The automation run failed",
            route: `/upcoming/${a.id}`,
            dedupeKey: `automation:${a.id}:failed`,
            ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
          });
          notificationId = n.id;
        }
      } catch (e) {
        this.#error(e);
      }
    }
    const nowIso = this.#iso();
    this.#tx(() => {
      this.#db.sqlite
        .prepare(
          "UPDATE automation_runs SET status = ?, summary = ?, ended_at = ?, notification_id = COALESCE(?, notification_id), task_id = COALESCE(task_id, ?) WHERE id = ?",
        )
        .run(
          result.status,
          result.summary === null ? null : result.summary.slice(0, SUMMARY_MAX),
          nowIso,
          notificationId,
          result.taskId ?? null,
          runId,
        );
      this.#db.sqlite
        .prepare("UPDATE automations SET last_status = ?, updated_at = ? WHERE id = ?")
        .run(result.status, nowIso, row.automation_id);
    });
    const events: Pending[] = [
      { event: "automation.run.finished", payload: { run: runFromRow(this.#runRow(runId)) } },
    ];
    if (automation !== undefined) events.push(this.#updatedEvent(row.automation_id));
    this.#emit(events);
  }

  /** Run history, newest first (`automations.runs`). */
  runs(automationId: string, page: { cursor?: string; limit?: number } = {}) {
    this.#row(automationId);
    const limit = Math.max(1, Math.min(page.limit ?? 50, 500));
    let after: [string, string] | undefined;
    if (page.cursor !== undefined) {
      try {
        after = JSON.parse(Buffer.from(page.cursor, "base64url").toString()) as [string, string];
      } catch {
        bad("bad cursor");
      }
      if (!Array.isArray(after) || after.length !== 2) bad("bad cursor");
    }
    const rows = (
      after === undefined
        ? this.#db.sqlite
            .prepare(
              "SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC, id DESC LIMIT ?",
            )
            .all(automationId, limit + 1)
        : this.#db.sqlite
            .prepare(
              "SELECT * FROM automation_runs WHERE automation_id = ? AND (started_at < ? OR (started_at = ? AND id < ?)) ORDER BY started_at DESC, id DESC LIMIT ?",
            )
            .all(automationId, after[0], after[0], after[1], limit + 1)
    ) as RunRow[];
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      runs: items.map(runFromRow),
      nextCursor:
        rows.length > limit && last !== undefined
          ? Buffer.from(JSON.stringify([last.started_at, last.id])).toString("base64url")
          : null,
    };
  }

  // --- watches ---------------------------------------------------------------------------------

  async #runWatch(automation: Automation, run: RunRow): Promise<void> {
    const w = this.#watchRow(automation.id);
    const fetch = this.#o.watchFetch;
    if (w === undefined || fetch === undefined) {
      await this.#finish(run.id, { status: "failed", summary: "No watch fetcher is configured" });
      return;
    }
    const nowIso = this.#iso();
    let page: { status: number; text: string };
    try {
      page = await fetch(w.url, {});
      if (page.status >= 400) throw new Error(`HTTP ${page.status}`);
    } catch (e) {
      // Exponential backoff: interval × 2^failures, capped.
      const failures = w.failures + 1;
      const interval = this.#schedule(automation).intervalMs ?? 3_600_000;
      const cap = this.#o.maxBackoffMs ?? 86_400_000;
      const delay = Math.min(interval * 2 ** Math.min(failures, 20), cap);
      this.#tx(() => {
        this.#db.sqlite
          .prepare(
            "UPDATE watches SET failures = ?, last_checked_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(failures, nowIso, nowIso, w.id);
        this.#db.sqlite
          .prepare("UPDATE automations SET next_run_at = ? WHERE id = ? AND enabled = 1")
          .run(this.#iso(this.clock.now() + delay), automation.id);
      });
      this.#arm();
      await this.#finish(run.id, {
        status: "failed",
        summary: `Check failed (${failures} in a row): ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    const verdict = evaluateWatch(w, page.text);
    let notificationId: string | undefined;
    if (verdict.alert && this.#o.notifier !== undefined) {
      try {
        notificationId = (
          await this.#o.notifier.notify({
            kind: "proactive",
            title: automation.title,
            body: verdict.summary,
            route: `/upcoming/${automation.id}`,
            dedupeKey: `watch:${automation.id}:${verdict.alertedValue ?? verdict.value}`,
          })
        ).id;
      } catch (e) {
        this.#error(e);
      }
    }
    this.#db.sqlite
      .prepare(
        "UPDATE watches SET last_value = ?, alerted_value = ?, failures = 0, last_checked_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(verdict.value, verdict.alertedValue, nowIso, nowIso, w.id);
    if (notificationId !== undefined) {
      this.#db.sqlite
        .prepare("UPDATE automation_runs SET notification_id = ? WHERE id = ?")
        .run(notificationId, run.id);
    }
    await this.#finish(run.id, {
      status: verdict.alert ? "done" : "no_reply",
      summary: verdict.summary,
    });
  }

  // --- heartbeat --------------------------------------------------------------------------------

  /**
   * The heartbeat as a system automation (architecture §4.11, feature O2): a light-context
   * check-in every 30 or 60 minutes inside active hours, in the main session, surfacing at most
   * one notification per run and `NO_REPLY` otherwise.
   */
  async ensureHeartbeat(
    options: {
      everyMinutes?: 30 | 60;
      activeHours?: { start: number; end: number };
      timezone?: string;
      enabled?: boolean;
      prompt?: string;
    } = {},
  ): Promise<Automation> {
    const every = options.everyMinutes ?? 30;
    if (every !== 30 && every !== 60) bad("heartbeat runs every 30 or 60 minutes");
    const { start, end } = options.activeHours ?? { start: 8, end: 22 };
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > 24 ||
      start >= end
    ) {
      bad("activeHours needs whole hours with 0 <= start < end <= 24");
    }
    const schedule = `${every === 30 ? "0,30" : "0"} ${start}-${end - 1} * * *`;
    const fields = {
      title: "Heartbeat",
      schedule,
      timezone: options.timezone ?? this.#o.defaultTimezone ?? "UTC",
      sessionTarget: "main",
      delivery: {},
      prompt: options.prompt ?? HEARTBEAT_PROMPT,
      enabled: options.enabled ?? true,
      lightContext: true,
    };
    const existing = this.#db.sqlite
      .prepare("SELECT id FROM automations WHERE kind = 'heartbeat' AND system = 1 LIMIT 1")
      .get() as { id: string } | undefined;
    if (existing !== undefined) return this.update(existing.id, fields);
    return this.create({ kind: "heartbeat", scratch: null, system: true, ...fields });
  }

  // --- Upcoming --------------------------------------------------------------------------------

  /** Everything that will run, soonest first, then open input requests (O4). */
  upcoming(options: { horizonMs?: number; limit?: number } = {}): UpcomingItem[] {
    const horizon = this.#iso(this.clock.now() + (options.horizonMs ?? 7 * 86_400_000));
    const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
    const rows = this.#db.sqlite
      .prepare(
        "SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id LIMIT ?",
      )
      .all(horizon, limit) as AutomationRow[];
    const items: UpcomingItem[] = rows.map((r) => ({
      kind:
        r.kind === "cron" || r.kind === "interval"
          ? "automation"
          : (r.kind as "reminder" | "briefing" | "heartbeat" | "watch"),
      id: r.id,
      automationId: r.id,
      title: r.title,
      nextRunAt: r.next_run_at,
      enabled: true,
      schedule: r.schedule,
      timezone: r.timezone,
    }));
    for (const req of this.#o.openInputRequests?.() ?? []) {
      if (items.length >= limit) break;
      items.push({
        kind: "input_request",
        id: req.id,
        title: req.questions[0]?.question ?? "Input needed",
        nextRunAt: null,
        enabled: true,
        ...(req.taskId == null ? {} : { taskId: req.taskId }),
      });
    }
    return items;
  }

  // --- host timer ------------------------------------------------------------------------------

  /** Re-follow runs left `running` by a restart, catch up, and arm the host timer. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const stale = this.#db.sqlite
      .prepare("SELECT * FROM automation_runs WHERE status = 'running'")
      .all() as RunRow[];
    for (const r of stale) {
      const followed = this.#o.launcher?.reattach?.(runFromRow(r));
      if (followed === undefined) {
        this.#track(
          this.#finish(r.id, { status: "cancelled", summary: "Interrupted by a restart" }),
        );
      } else {
        this.#track(followed.then((result) => this.#finish(r.id, result)));
      }
    }
    await this.tick();
  }

  stop(): void {
    this.#started = false;
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** The machine woke from sleep (or the clock jumped): catch up now. */
  async wake(): Promise<ScheduledRun[]> {
    return this.tick();
  }

  /** Time of the single host timer, or `undefined` when nothing is scheduled (tests). */
  get armedFor(): number | undefined {
    return this.#armedFor;
  }

  #armedFor: number | undefined;

  #arm(): void {
    if (!this.#started) return;
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#armedFor = undefined;
    const row = this.#db.sqlite
      .prepare(
        "SELECT MIN(next_run_at) AS at FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL",
      )
      .get() as { at: string | null };
    if (row.at === null) return;
    const now = this.clock.now();
    const delay = Math.max(0, Math.min(Date.parse(row.at) - now, this.#o.maxTimerMs ?? 300_000));
    this.#armedFor = now + delay;
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      this.tick().catch((e) => this.#error(e));
    }, delay);
  }
}

export const HEARTBEAT_PROMPT =
  "Heartbeat check-in. Look at what changed since the last check-in (calendar, inbox, running tasks, goals). If one thing needs the owner's attention now, say it in one short message. Otherwise reply exactly NO_REPLY.";
