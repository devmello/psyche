import type {
  Decision,
  ProvenanceOut,
  SideEffect,
  Target,
  ToolCall,
  ToolCallStatus,
} from "@psyche/protocol";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { encodeJson, fromBool, toolCallFromRow } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { runs, toolCalls, toolPayloads } from "../schema.ts";

export interface ToolCallUpsert {
  readonly id: string;
  readonly runId: string;
  readonly messageId?: string | null;
  readonly tool: string;
  readonly status: ToolCallStatus;
  readonly paramsRedacted?: unknown;
  readonly paramsHash?: string;
  readonly sideEffect?: SideEffect;
  readonly target?: Target | null;
  readonly decision?: Decision | null;
  readonly decisionRule?: string | null;
  readonly approvalId?: string | null;
  readonly taintIn?: boolean;
  readonly taintOut?: boolean;
  readonly resultRef?: string | null;
  readonly provenanceOut?: ProvenanceOut;
  readonly receiptId?: string | null;
  /** The run-trace step that shows the call. */
  readonly stepId?: string;
}

const TERMINAL: readonly ToolCallStatus[] = ["ok", "failed", "uncertain", "blocked"];

/**
 * Inserts a tool call on first sight and merges later updates: fields left `undefined` keep
 * their stored value; reaching a terminal status sets `ended_at`.
 */
export function upsertToolCall(db: PsycheDb, input: ToolCallUpsert): ToolCall {
  const at = db.now();
  const existing = db.drizzle.select().from(toolCalls).where(eq(toolCalls.id, input.id)).get();
  const endedAt = TERMINAL.includes(input.status) ? (existing?.endedAt ?? at) : null;
  if (existing === undefined) {
    const row = db.drizzle
      .insert(toolCalls)
      .values({
        id: input.id,
        runId: input.runId,
        messageId: input.messageId ?? null,
        tool: input.tool,
        paramsRedacted: JSON.stringify(input.paramsRedacted ?? {}),
        paramsHash: input.paramsHash ?? "",
        sideEffect: input.sideEffect ?? "none",
        target: encodeJson(input.target ?? undefined),
        decision: input.decision ?? null,
        decisionRule: input.decisionRule ?? null,
        approvalId: input.approvalId ?? null,
        taintIn: fromBool(input.taintIn),
        taintOut: fromBool(input.taintOut),
        resultRef: input.resultRef ?? null,
        provenanceOut: input.provenanceOut ?? "trusted",
        receiptId: input.receiptId ?? null,
        stepId: input.stepId ?? null,
        startedAt: at,
        endedAt,
        status: input.status,
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    return toolCallFromRow(row);
  }
  const set: Partial<typeof toolCalls.$inferInsert> = {
    status: input.status,
    endedAt,
    updatedAt: at,
  };
  if (input.messageId !== undefined) set.messageId = input.messageId;
  if (input.paramsRedacted !== undefined) set.paramsRedacted = JSON.stringify(input.paramsRedacted);
  if (input.paramsHash !== undefined) set.paramsHash = input.paramsHash;
  if (input.sideEffect !== undefined) set.sideEffect = input.sideEffect;
  if (input.target !== undefined) set.target = encodeJson(input.target ?? undefined);
  if (input.decision !== undefined) set.decision = input.decision;
  if (input.decisionRule !== undefined) set.decisionRule = input.decisionRule;
  if (input.approvalId !== undefined) set.approvalId = input.approvalId;
  if (input.taintIn !== undefined) set.taintIn = fromBool(input.taintIn);
  if (input.taintOut !== undefined) set.taintOut = fromBool(input.taintOut);
  if (input.resultRef !== undefined) set.resultRef = input.resultRef;
  if (input.provenanceOut !== undefined) set.provenanceOut = input.provenanceOut;
  if (input.receiptId !== undefined) set.receiptId = input.receiptId;
  if (input.stepId !== undefined) set.stepId = input.stepId;
  const row = db.drizzle
    .update(toolCalls)
    .set(set)
    .where(eq(toolCalls.id, input.id))
    .returning()
    .get();
  return toolCallFromRow(row ?? existing);
}

export function getToolCall(db: PsycheDb, id: string): ToolCall | undefined {
  const row = db.drizzle.select().from(toolCalls).where(eq(toolCalls.id, id)).get();
  return row === undefined ? undefined : toolCallFromRow(row);
}

export function listToolCallsForRun(db: PsycheDb, runId: string): ToolCall[] {
  return db.drizzle
    .select()
    .from(toolCalls)
    .where(eq(toolCalls.runId, runId))
    .all()
    .map(toolCallFromRow);
}

/**
 * Restart recovery: tool calls still `pending` or `running` in a run that was still `running`
 * were interrupted, so whether their side effect happened is unknown. They become `uncertain` and
 * are never re-dispatched. Calls of runs suspended for an approval or input are left alone: the
 * suspended work resumes them.
 */
export function markInterruptedToolCalls(db: PsycheDb): ToolCall[] {
  const at = db.now();
  return db.drizzle
    .update(toolCalls)
    .set({ status: "uncertain", endedAt: at, updatedAt: at })
    .where(
      and(
        inArray(toolCalls.status, ["pending", "running"]),
        inArray(
          toolCalls.runId,
          db.drizzle.select({ id: runs.id }).from(runs).where(eq(runs.status, "running")),
        ),
      ),
    )
    .returning()
    .all()
    .map(toolCallFromRow);
}

// --- Level-3 payloads (data model §12) ---------------------------------------------------------

export interface NewToolPayload {
  readonly toolCallId: string;
  readonly kind: "params" | "result" | "screenshot";
  readonly mime: string;
  readonly data: Uint8Array;
  /** The run-trace step it belongs to (`runs.step`). */
  readonly stepId?: string;
  /** Over the 1 MB cap: the head and tail were kept (run trace §4.5). */
  readonly truncated?: boolean;
}

/** Stores a payload and returns its `result_ref` form, `payload:<id>`. */
export function putToolPayload(db: PsycheDb, input: NewToolPayload): string {
  const id = db.newId();
  db.drizzle
    .insert(toolPayloads)
    .values({
      id,
      toolCallId: input.toolCallId,
      kind: input.kind,
      mime: input.mime,
      data: Buffer.from(input.data),
      createdAt: db.now(),
      stepId: input.stepId ?? null,
      truncated: input.truncated === true ? 1 : 0,
    })
    .run();
  return `payload:${id}`;
}

export function countToolPayloads(db: PsycheDb): number {
  const row = db.drizzle.select({ n: sql<number>`count(*)` }).from(toolPayloads).get();
  return row?.n ?? 0;
}

/**
 * Deletes payloads created before `cutoff` and clears `tool_calls.result_ref` values that
 * pointed at them. Returns how many payloads were deleted.
 */
export function deleteToolPayloadsBefore(db: PsycheDb, cutoff: string): number {
  return db.sqlite.transaction(() => {
    db.sqlite.prepare("DELETE FROM step_payloads WHERE created_at < ?").run(cutoff);
    const doomed = db.drizzle
      .select({ id: toolPayloads.id })
      .from(toolPayloads)
      .where(lt(toolPayloads.createdAt, cutoff))
      .all()
      .map((r) => r.id);
    if (doomed.length === 0) return 0;
    for (let i = 0; i < doomed.length; i += 500) {
      const chunk = doomed.slice(i, i + 500);
      db.drizzle
        .update(toolCalls)
        .set({ resultRef: null, updatedAt: db.now() })
        .where(
          and(
            sql`${toolCalls.resultRef} IS NOT NULL`,
            inArray(
              toolCalls.resultRef,
              chunk.map((id) => `payload:${id}`),
            ),
          ),
        )
        .run();
      db.drizzle.delete(toolPayloads).where(inArray(toolPayloads.id, chunk)).run();
    }
    return doomed.length;
  })();
}
