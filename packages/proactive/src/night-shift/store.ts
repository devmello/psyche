import type {
  NightShiftNight,
  NightShiftNightStatus,
  NightShiftReviewStatus,
  StagedAction,
  StagedActionSend,
  StagedActionStatus,
  TaintSource,
} from "@psyche/protocol";

/**
 * What Night shift needs from storage (docs/design/night-shift-2026.md §6.1). The Gateway backs it
 * with the `@psyche/db` repo functions (`apps/gateway/src/compose/night-shift.ts`); the tests back
 * it with the same functions on a real in-memory SQLite database. Rows in, rows out: the service
 * owns the rules.
 */

export interface NewNightInput {
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

export type NightPatchInput = Partial<Omit<NewNightInput, "night">>;

export interface NewStagedInput {
  /** Exactly one of `nightId` and `forkBranchId` (the table's CHECK enforces it). */
  nightId?: string;
  forkBranchId?: string;
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

export interface StagedPatchInput {
  status?: StagedActionStatus;
  result?: StagedAction["result"];
  approvalId?: string | null;
  appliedAt?: string | null;
  clearParams?: boolean;
  /** The undo data recorded after an apply. */
  inverse?: unknown;
}

export interface NightStore {
  getNight(id: string): NightShiftNight | null;
  getNightByDate(night: string): NightShiftNight | null;
  insertNight(input: NewNightInput): NightShiftNight;
  updateNight(id: string, patch: NightPatchInput): NightShiftNight | null;
  listNights(reviewStatus?: NightShiftReviewStatus): NightShiftNight[];
  insertStagedAction(input: NewStagedInput): StagedAction;
  getStagedAction(id: string): StagedAction | null;
  listStagedActions(nightId: string): StagedAction[];
  updateStagedAction(id: string, patch: StagedPatchInput): StagedAction | null;
}

/** The ready items of a night, counted per domain (the Home card and the brief line). */
export function readyCounts(
  items: readonly StagedAction[],
): Record<StagedAction["domain"], number> {
  const out = { mail: 0, calendar: 0, reminders: 0, files: 0 };
  for (const i of items) if (i.status === "ready") out[i.domain] += 1;
  return out;
}
