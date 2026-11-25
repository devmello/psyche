import type {
  NightShiftNight,
  NightShiftNightStatus,
  NightShiftReviewStatus,
  StagedAction,
  StagedActionSend,
  StagedActionStatus,
  TaintSource,
} from "@psyche/protocol";
import { and, asc, eq } from "drizzle-orm";
import type { PsycheDb } from "../open.ts";
import {
  type NightShiftNightRow,
  nightShiftNights,
  type StagedActionRow,
  stagedActions,
} from "../schema.ts";

/**
 * Night shift storage (docs/design/night-shift-2026.md §6.1). Rows in, rows out: the service
 * owns the rules (allowlist, preconditions, expiry); nothing here runs a tool or decides trust.
 */

const json = (v: unknown): string | null =>
  v === undefined || v === null ? null : JSON.stringify(v);
const parse = <T>(v: string | null): T | null => (v === null ? null : (JSON.parse(v) as T));

export function nightFromRow(row: NightShiftNightRow): NightShiftNight {
  return {
    id: row.id as string,
    night: row.night,
    status: row.status as NightShiftNightStatus,
    stopReason: row.stopReason,
    candidates: parse<unknown>(row.candidates),
    spentUsd: row.spentUsd,
    tokens: row.tokens,
    reviewStatus: row.reviewStatus as NightShiftReviewStatus,
    expiresAt: row.expiresAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function stagedActionFromRow(row: StagedActionRow): StagedAction {
  return {
    id: row.id as string,
    nightId: row.nightId,
    seq: row.seq,
    domain: row.domain as StagedAction["domain"],
    targetKey: row.targetKey,
    tool: row.tool,
    kind: row.kind,
    sideEffect: row.sideEffect,
    target: parse<unknown>(row.target),
    params: parse<unknown>(row.params),
    paramsHash: row.paramsHash,
    bindingHash: row.bindingHash,
    summary: row.summary,
    preview: parse<unknown>(row.preview),
    why: row.why,
    precondition: parse<unknown>(row.precondition),
    inverse: parse<unknown>(row.inverse),
    send: parse<StagedActionSend>(row.send),
    taint: row.taint === 1,
    taintSources: JSON.parse(row.taintSources) as TaintSource[],
    status: row.status as StagedActionStatus,
    result: parse<StagedAction["result"]>(row.result),
    approvalId: row.approvalId,
    taskId: row.taskId,
    toolCallId: row.toolCallId,
    appliedAt: row.appliedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface NewNight {
  id?: string;
  night: string;
  status: NightShiftNightStatus;
  stopReason?: string | null;
  candidates?: unknown;
  spentUsd?: number;
  tokens?: number;
  reviewStatus?: NightShiftReviewStatus;
  expiresAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export function insertNight(db: PsycheDb, input: NewNight): NightShiftNight {
  const now = db.now();
  const row = db.drizzle
    .insert(nightShiftNights)
    .values({
      id: input.id ?? db.newId(),
      night: input.night,
      status: input.status,
      stopReason: input.stopReason ?? null,
      candidates: json(input.candidates),
      spentUsd: input.spentUsd ?? 0,
      tokens: input.tokens ?? 0,
      reviewStatus: input.reviewStatus ?? "none",
      expiresAt: input.expiresAt ?? null,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return nightFromRow(row);
}

export function getNight(db: PsycheDb, id: string): NightShiftNight | null {
  const row = db.drizzle.select().from(nightShiftNights).where(eq(nightShiftNights.id, id)).get();
  return row === undefined ? null : nightFromRow(row);
}

export function getNightByDate(db: PsycheDb, night: string): NightShiftNight | null {
  const row = db.drizzle
    .select()
    .from(nightShiftNights)
    .where(eq(nightShiftNights.night, night))
    .get();
  return row === undefined ? null : nightFromRow(row);
}

export type NightPatch = Partial<Omit<NewNight, "id" | "night">>;

export function updateNight(db: PsycheDb, id: string, patch: NightPatch): NightShiftNight | null {
  const set: Partial<typeof nightShiftNights.$inferInsert> = { updatedAt: db.now() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.stopReason !== undefined) set.stopReason = patch.stopReason;
  if (patch.candidates !== undefined) set.candidates = json(patch.candidates);
  if (patch.spentUsd !== undefined) set.spentUsd = patch.spentUsd;
  if (patch.tokens !== undefined) set.tokens = patch.tokens;
  if (patch.reviewStatus !== undefined) set.reviewStatus = patch.reviewStatus;
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
  if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
  const row = db.drizzle
    .update(nightShiftNights)
    .set(set)
    .where(eq(nightShiftNights.id, id))
    .returning()
    .get();
  return row === undefined ? null : nightFromRow(row);
}

export function listNights(db: PsycheDb, reviewStatus?: NightShiftReviewStatus): NightShiftNight[] {
  const q = db.drizzle.select().from(nightShiftNights);
  const rows = (
    reviewStatus === undefined ? q : q.where(eq(nightShiftNights.reviewStatus, reviewStatus))
  )
    .orderBy(asc(nightShiftNights.night))
    .all();
  return rows.map(nightFromRow);
}

export interface NewStagedAction {
  id?: string;
  nightId: string;
  seq: number;
  domain: StagedAction["domain"];
  targetKey: string;
  tool: string;
  kind: string;
  sideEffect: string;
  target?: unknown;
  params?: unknown;
  paramsHash: string;
  bindingHash: string;
  summary: string;
  preview?: unknown;
  why?: string | null;
  precondition?: unknown;
  inverse?: unknown;
  send?: StagedActionSend | null;
  taint?: boolean;
  taintSources?: readonly TaintSource[];
  taskId?: string | null;
  toolCallId?: string | null;
}

/**
 * Inserts a `ready` item. A live item for the same night and target is marked `superseded` first
 * (one live item per target per night, §2.4); the caller decides whether that is a fold or a
 * replace before calling.
 */
export function insertStagedAction(db: PsycheDb, input: NewStagedAction): StagedAction {
  const now = db.now();
  return db.sqlite.transaction(() => {
    db.drizzle
      .update(stagedActions)
      .set({ status: "superseded", updatedAt: now })
      .where(
        and(
          eq(stagedActions.nightId, input.nightId),
          eq(stagedActions.targetKey, input.targetKey),
          eq(stagedActions.status, "ready"),
        ),
      )
      .run();
    const row = db.drizzle
      .insert(stagedActions)
      .values({
        id: input.id ?? db.newId(),
        nightId: input.nightId,
        seq: input.seq,
        domain: input.domain,
        targetKey: input.targetKey,
        tool: input.tool,
        kind: input.kind,
        sideEffect: input.sideEffect,
        target: json(input.target),
        params: json(input.params),
        paramsHash: input.paramsHash,
        bindingHash: input.bindingHash,
        summary: input.summary,
        preview: json(input.preview),
        why: input.why ?? null,
        precondition: json(input.precondition),
        inverse: json(input.inverse),
        send: json(input.send),
        taint: input.taint === true ? 1 : 0,
        taintSources: JSON.stringify(input.taintSources ?? []),
        status: "ready",
        result: null,
        approvalId: null,
        taskId: input.taskId ?? null,
        toolCallId: input.toolCallId ?? null,
        appliedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return stagedActionFromRow(row);
  })();
}

export function getStagedAction(db: PsycheDb, id: string): StagedAction | null {
  const row = db.drizzle.select().from(stagedActions).where(eq(stagedActions.id, id)).get();
  return row === undefined ? null : stagedActionFromRow(row);
}

export function listStagedActions(db: PsycheDb, nightId: string): StagedAction[] {
  return db.drizzle
    .select()
    .from(stagedActions)
    .where(eq(stagedActions.nightId, nightId))
    .orderBy(asc(stagedActions.seq))
    .all()
    .map(stagedActionFromRow);
}

export interface StagedActionPatch {
  status?: StagedActionStatus;
  result?: StagedAction["result"];
  approvalId?: string | null;
  appliedAt?: string | null;
  /** Expiry: clears the frozen call and its preview, keeps the row for counts. */
  clearParams?: boolean;
}

export function updateStagedAction(
  db: PsycheDb,
  id: string,
  patch: StagedActionPatch,
): StagedAction | null {
  const set: Partial<typeof stagedActions.$inferInsert> = { updatedAt: db.now() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.result !== undefined) set.result = json(patch.result);
  if (patch.approvalId !== undefined) set.approvalId = patch.approvalId;
  if (patch.appliedAt !== undefined) set.appliedAt = patch.appliedAt;
  if (patch.clearParams === true) {
    set.params = null;
    set.preview = null;
  }
  const row = db.drizzle
    .update(stagedActions)
    .set(set)
    .where(eq(stagedActions.id, id))
    .returning()
    .get();
  return row === undefined ? null : stagedActionFromRow(row);
}
