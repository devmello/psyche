import {
  BUDGET_OPTIONS,
  BUDGET_PAUSE_HEADER,
  budgetDecisionOf,
  type SpecialistHost,
  type SpecialistJobInput,
  type SpecialistReportInput,
  type SpecialistReportMeta,
  type SpecialistRoleDef,
} from "@psyche/agent-core";
import { appendMessage, createThread, getSetting, type PsycheDb } from "@psyche/db";
import { sanitizeBlock } from "@psyche/permissions";
import type {
  EventName,
  EventPayload,
  ModelRef,
  PermissionBroker,
  SpecialistJob,
  SpecialistResult,
  SpecialistSpec,
  Task,
} from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import { type FsSkillLoader, specialistsPromptSection } from "@psyche/skills";
import type { SqliteTaskEngine } from "@psyche/tasks";
import { INCOGNITO_TTL_MS } from "../handlers/threads.ts";

/**
 * The Gateway side of background specialists (docs/agent/specialists-2026.md §4): roles from the
 * role skills plus the owner's `specialists.*` settings, jobs as a thread + Task, and the one
 * sanitized result. The pool, budgets and delivery card come in later parts of #683.
 */

/** The role skills (`FsSkillLoader.specialistRoles()`). */
export type RoleSource = Pick<FsSkillLoader, "specialistRoles">;

export interface SpecialistHostDeps {
  db: PsycheDb;
  tasks: SqliteTaskEngine;
  broker: Pick<PermissionBroker, "listReceipts">;
  roles: RoleSource;
  /** Router roles: `primary` and the optional `utility` model. */
  models: { primary: ModelRef; utility?: ModelRef };
  now: () => number;
  /** The specialist pool's slots (`specialists.maxConcurrent`). */
  slots?: () => number;
  /** Wake the specialist pool after a spawn. */
  poke?: () => void;
  /** Publishes events; with it a reported result is also posted to the spawning thread. */
  publish?: <E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string) => void;
}

const setting = (db: PsycheDb, key: string): unknown => getSetting(db, key)?.value;

function modelFor(
  db: PsycheDb,
  role: string,
  modelClass: string,
  models: SpecialistHostDeps["models"],
): ModelRef {
  const pinned = setting(db, `specialists.model.${role}`);
  if (typeof pinned === "string" && pinned.includes("/")) return pinned;
  // Harness and vision roles run on the primary model until the router has those roles.
  return modelClass === "utility" ? (models.utility ?? models.primary) : models.primary;
}

/**
 * Control and bidi characters go (`sanitizeBlock`), and instruction-shaped markup is defused:
 * chat-template tokens (`<|im_start|>`) and role or fence tags (`<system>`, `</section>`) get a
 * zero-width joiner after `<`, so no reader can take them for structure (specialists §4.2).
 */
export function defuse(text: string): string {
  return sanitizeBlock(text)
    .replace(/<\|/g, "<\u200D|")
    .replace(
      /<(\/?)\s*(system|user|assistant|developer|section|tool|instructions?)\b/gi,
      "<\u200D$1$2",
    );
}

const clip = (s: string, n: number) => defuse(s).slice(0, n);

/** `specialist.report` text is model output: sanitize every field before anyone reads it. */
export function sanitizeReport(r: SpecialistReportInput): SpecialistReportInput {
  return {
    outcome: r.outcome,
    summary: clip(r.summary, 600),
    ...(r.findings === undefined
      ? {}
      : {
          findings: r.findings.slice(0, 12).map((f) => ({
            title: clip(f.title, 200),
            detail: clip(f.detail, 2_000),
            ...(f.sources === undefined
              ? {}
              : { sources: f.sources.slice(0, 10).map((x) => clip(x, 2_048)) }),
          })),
        }),
    ...(r.artifacts === undefined ? {} : { artifacts: r.artifacts.slice(0, 32) }),
    ...(r.next === undefined
      ? {}
      : {
          next: r.next
            .slice(0, 2)
            .map((n) => ({ label: clip(n.label, 60), message: clip(n.message, 300) })),
        }),
    ...(r.gaps === undefined ? {} : { gaps: r.gaps.slice(0, 12).map((g) => clip(g, 300)) }),
  };
}

function jobOf(task: Task, queuePosition: number | null = null): SpecialistJob | undefined {
  const s = task.specialist;
  if (s === undefined) return undefined;
  const status: SpecialistJob["status"] =
    s.result != null
      ? s.result.outcome
      : task.status === "queued"
        ? "queued"
        : task.status === "awaiting_approval" || task.status === "awaiting_input"
          ? "needs_you"
          : task.status === "cancelled"
            ? "cancelled"
            : task.status === "failed"
              ? "failed"
              : task.status === "done"
                ? "done"
                : "working";
  return {
    taskId: task.id,
    runId: null,
    threadId: task.threadId,
    parentThreadId: s.parentThreadId,
    parentRunId: s.parentRunId,
    role: s.role,
    title: task.title,
    status,
    queuePosition: task.status === "queued" ? queuePosition : null,
    budget: s.budget,
    deadline: s.deadline ?? null,
    lastStep: null,
    ...(s.preflight === undefined ? {} : { preflight: s.preflight }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    result: s.result ?? null,
  };
}

export function createSpecialistHost(deps: SpecialistHostDeps): SpecialistHost {
  const { db, tasks } = deps;
  /**
   * Places in the specialist queue, oldest first, once every slot is busy: a queued job's
   * position is its rank among queued jobs past the free slots (specialists §4.5).
   */
  const positions = async (): Promise<Map<string, number>> => {
    const specialistTasks = (await tasks.list({ status: ["queued", "running"] })).filter(
      (t) => t.createdFrom === "subagent" && t.specialist !== undefined,
    );
    const running = specialistTasks.filter((t) => t.status === "running").length;
    const queued = specialistTasks
      .filter((t) => t.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const free = Math.max(0, (deps.slots?.() ?? 3) - running);
    const out = new Map<string, number>();
    queued.forEach((t, i) => {
      if (i >= free) out.set(t.id, i - free + 1);
    });
    return out;
  };
  const roles = async (): Promise<SpecialistRoleDef[]> => {
    const out: SpecialistRoleDef[] = [];
    for (const r of await deps.roles.specialistRoles()) {
      const on = setting(db, `specialists.enabled.${r.role.role}`);
      if (!(typeof on === "boolean" ? on : r.defaultOn)) continue;
      out.push({
        role: r.role.role,
        label: r.role.label,
        description: r.role.description,
        prompt: r.body,
        model: modelFor(db, r.role.role, r.role.modelClass, deps.models),
        maxMode: r.role.maxMode,
        tools: [...r.role.tools],
        memory: r.skill.specialist?.memory ?? "none",
        result: r.role.result,
        planFirst: r.role.planFirst,
        budget: { ...r.role.budget },
        caps: { ...r.role.caps },
        approvals: [...r.role.approvals],
      });
    }
    return out;
  };

  /**
   * The result also goes to the thread that spawned the job as a `specialist_result` block
   * (chat-experience-2026 §4.5, decision 7); Feed and Inbox read the same job, so both stay. The
   * parent's turn may still hold the transcript: try as no writer, then as the parent run, and
   * never fail the report over it.
   */
  const postResult = (taskId: string, threadId: string, parentRunId: string | null): void => {
    if (deps.publish === undefined) return;
    const block = { type: "specialist_result" as const, taskId };
    for (const writer of parentRunId === null ? [null] : [null, parentRunId]) {
      try {
        const message = appendMessage(
          db,
          { threadId, role: "system", blocks: [block], provenance: "agent", runId: null },
          { expectedWriterRunId: writer },
        );
        deps.publish("chat.message", { message }, threadId);
        return;
      } catch {
        // Try the next writer.
      }
    }
  };

  return {
    roles,
    async createJob(input: SpecialistJobInput) {
      const thread = createThread(db, {
        // An incognito parent's job is incognito too: no flush, no index, the same expiry (§4.9).
        kind: input.incognito ? "incognito" : "subagent",
        sessionKey: `specialist:${input.spec.role}:${db.newId()}`,
        title: input.title,
        titleSource: "user",
        parentThreadId: input.spec.parentThreadId,
        permissionMode: input.spec.permissionMode,
        modelRef: input.spec.model,
        expiresAt: input.incognito ? new Date(deps.now() + INCOGNITO_TTL_MS).toISOString() : null,
      });
      const task = await tasks.create({
        threadId: thread.id,
        title: input.title,
        goal: input.brief,
        createdFrom: "subagent",
        ...(input.unattended === true ? { mode: "unattended" as const } : {}),
        ...(input.taint ? { taint: true, taintSources: input.taintSources } : {}),
        specialist: input.spec,
      });
      const queuePosition = (await positions()).get(task.id) ?? null;
      deps.poke?.();
      return { taskId: task.id, threadId: thread.id, queuePosition };
    },
    async jobs(parentThreadId: string) {
      const all = await tasks.list({});
      const place = await positions();
      return all
        .map((t) => jobOf(t, place.get(t.id) ?? null))
        .filter((j): j is SpecialistJob => j !== undefined && j.parentThreadId === parentThreadId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async report(taskId: string, report: SpecialistReportInput, meta: SpecialistReportMeta) {
      const clean = sanitizeReport(report);
      const receipts = (await deps.broker.listReceipts({ taskId })).map((r) => r.id);
      let stored: SpecialistResult | undefined;
      let first: { parentThreadId: string; parentRunId: string | null } | undefined;
      await tasks.updateSpecialist(taskId, (spec) => {
        // One result per job: a second report keeps the first (§4.2).
        if (spec.result != null) {
          stored = spec.result;
          return spec;
        }
        first = { parentThreadId: spec.parentThreadId, parentRunId: spec.parentRunId ?? null };
        stored = {
          outcome: clean.outcome,
          summary: clean.summary,
          findings: clean.findings ?? [],
          artifacts: clean.artifacts ?? [],
          next: clean.next ?? [],
          gaps: clean.gaps ?? [],
          receipts,
          tainted: meta.tainted,
          ...(meta.stopReason === undefined ? {} : { stopReason: meta.stopReason }),
        };
        return { ...spec, result: stored };
      });
      if (first !== undefined) postResult(taskId, first.parentThreadId, first.parentRunId);
      return stored as SpecialistResult;
    },
    async promptSection() {
      return specialistsPromptSection(await roles());
    },
    async updateSpec(taskId, patch) {
      const task = await tasks.updateSpecialist(taskId, patch);
      return task.specialist as SpecialistSpec;
    },
    async budgetDecision(taskId) {
      const spec = (await tasks.get(taskId))?.specialist;
      const pause = spec?.budgetPause;
      if (pause == null) return undefined;
      if (pause.raised === true) return "raised";
      const request = tasks.inputRequests({ taskId }).find((r) => r.id === pause.inputRequestId);
      if (request === undefined || request.status !== "answered") return undefined;
      return budgetDecisionOf(request.answer?.[BUDGET_PAUSE_HEADER]);
    },
  };
}

/**
 * Raise a specialist job's budget or move its deadline (`tasks.update`, specialists §4.7), never
 * above the role's caps. A job paused on its budget is marked `raised` and its question is
 * answered "Give it more", so it re-queues without adding its own +50% on top.
 */
export async function raiseSpecialistBudget(
  deps: Pick<SpecialistHostDeps, "tasks"> & { host: Pick<SpecialistHost, "roles"> },
  taskId: string,
  patch: { tokens?: number; costUsd?: number; minutes?: number; deadline?: string },
): Promise<Task> {
  const { tasks } = deps;
  const spec = (await tasks.get(taskId))?.specialist;
  if (spec === undefined) {
    throw new PsycheError("invalid_params", `task ${taskId} is not a specialist's job`);
  }
  const role = (await deps.host.roles()).find((r) => r.role === spec.role);
  const cap = (v: number | undefined, c: number | undefined) =>
    v === undefined ? undefined : c === undefined ? v : Math.min(v, c);
  const tokens = cap(patch.tokens, role?.caps.tokens);
  const costUsd = cap(patch.costUsd, role?.caps.costUsd);
  const minutes = cap(patch.minutes, role?.caps.minutes);
  let deadline: string | undefined;
  if (patch.deadline !== undefined) {
    const at = Date.parse(patch.deadline);
    if (!Number.isFinite(at)) throw new PsycheError("invalid_params", "deadline must be ISO-8601");
    deadline = new Date(at).toISOString();
  }
  const pause = spec.budgetPause;
  let task = await tasks.updateSpecialist(taskId, (x) => ({
    ...x,
    budget: {
      ...x.budget,
      limit: {
        ...x.budget.limit,
        ...(tokens === undefined ? {} : { tokens }),
        ...(costUsd === undefined ? {} : { costUsd }),
        ...(minutes === undefined ? {} : { wallMs: minutes * 60_000 }),
      },
    },
    ...(deadline === undefined ? {} : { deadline }),
    ...(x.budgetPause == null ? {} : { budgetPause: { ...x.budgetPause, raised: true } }),
  }));
  if (pause != null) {
    const open = tasks
      .inputRequests({ taskId, status: "open" })
      .find((r) => r.id === pause.inputRequestId);
    if (open !== undefined) {
      await tasks.answerInput(open.id, { [BUDGET_PAUSE_HEADER]: BUDGET_OPTIONS.more });
      task = (await tasks.get(taskId)) ?? task;
    }
  }
  return task;
}
