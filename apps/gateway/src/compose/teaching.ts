import {
  appendMessage,
  getMessage,
  getSetting,
  getThread,
  listMessagesPage,
  type PsycheDb,
} from "@psyche/db";
import {
  type AskRules,
  computeGrowth,
  type GraphStore,
  graphEntityResolver,
  LessonWriter,
  publicLesson,
  type RouterTarget,
  type SqliteMemoryStore,
  TeachingService,
  type TeachingSettings,
  TeachingStore,
} from "@psyche/memory";
import {
  type ApprovalRequest,
  type AuditLog,
  type Block,
  type Clock,
  type EventName,
  type EventPayload,
  type FeedbackTarget,
  type FeedPost,
  type GrantScope,
  type Idea,
  type MethodParams,
  type MethodResult,
  type ModelProvider,
  type ModelRef,
  type PermissionBroker,
  type Scheduler,
  type Surface,
  type Task,
  type TaskEngine,
  TEACHING_SETTING_DEFAULTS,
  type TeachingImplicitSignals,
} from "@psyche/protocol";
import type { Call, ChatRedo, HandlerDef } from "../context.ts";
import type { Gateway } from "../server.ts";
import { surfaceOf } from "./handlers.ts";
import type { ComposedPart } from "./services.ts";
import { userProfileConfig } from "./user-profile.ts";

/**
 * The teaching loop's Gateway side (docs/agent/teaching-loop-2026.md §3–4, #679): `feedback.*`
 * and `memory.lessons.*` over `@psyche/memory`'s teaching service, the "Psyche will remember"
 * block under the corrected message, approval answers as implicit evidence, and the events the
 * Growth view and the marks refresh on. Lessons come only from the owner's own devices: the
 * caller of `feedback.give` is a paired device with `operator.write`; channel reactions are
 * refused unless they are the owner's own, never from a group or a delegated person.
 */

export interface TeachingComposeDeps {
  db: PsycheDb;
  memory: SqliteMemoryStore;
  provider: ModelProvider;
  model: ModelRef;
  /** False without a utility model: feedback is recorded but never routed. */
  active: boolean;
  /** A broker handle that announces the cards it issues (`approval.created`). */
  broker: PermissionBroker;
  clock: Clock;
  audit: AuditLog;
  scheduler: Scheduler;
  /** Lesson cards go to the owner's devices only. */
  surfaces: Surface[];
  /** Standing `ask` rules for boundaries (`permissions.policy`). */
  askRules: AskRules;
  /** The people graph, once the Gateway composes it (S07 part 3). */
  graph?: GraphStore;
  /** Task outcomes for `growth.summary`. */
  tasks: Pick<TaskEngine, "list">;
  /** How often retention runs (default daily; 0 turns the timer off). */
  retentionIntervalMs?: number;
  publish<E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string): void;
}

function setting<T>(db: PsycheDb, key: keyof typeof TEACHING_SETTING_DEFAULTS, fallback: T): T {
  const v = getSetting(db, key)?.value;
  return v === undefined || v === null ? fallback : (v as T);
}

/** The owner's teaching switches (§8), defaults from the protocol. */
export function teachingSettings(db: PsycheDb): TeachingSettings {
  const implicit = setting<Partial<TeachingImplicitSignals>>(db, "teaching.implicit", {});
  return {
    enabled: setting<boolean>(db, "teaching.enabled", true) !== false,
    paused: setting<boolean>(db, "teaching.paused", false) === true,
    implicit: { ...TEACHING_SETTING_DEFAULTS["teaching.implicit"], ...implicit },
    surfaces: setting<Record<string, boolean>>(db, "teaching.surfaces", {}),
    review: userProfileConfig(db).review,
  };
}

/** A message's text for the router, capped (it is quoted as data, never instructions). */
function messageText(db: PsycheDb, id: string): { text: string; owner: boolean } | undefined {
  const m = getMessage(db, id);
  if (m === undefined) return undefined;
  const text = m.blocks
    .flatMap((b) => (b.type === "text" ? [b.md] : []))
    .join("\n")
    .slice(0, 2_000);
  return { text, owner: m.provenance === "owner" };
}

const SCOPE_RANK: Record<GrantScope, number> = { once: 0, task: 1, site: 2, session: 2, always: 3 };

export interface ComposedTeaching {
  service: TeachingService;
  handlers: Record<string, HandlerDef>;
  /** An approval was decided: a narrower scope or a denial is implicit evidence (§3.1). */
  observeApproval(approval: ApprovalRequest): void;
  /** Gateway boot: re-await lesson cards that were open at shutdown. */
  resume(): Promise<void>;
  /** The owner undid a learned fact (`memory.forgetLearned`): `undo` evidence. */
  onLearnedUndo(factId: string, threadId: string | undefined): void;
  /** Bus observers (task cancels, Feed and Ideas feedback, redo) and the retention timer. */
  part: ComposedPart;
}

/** A task the owner cancelled this soon after it started counts as an undo (§3.1). */
export const QUICK_CANCEL_MS = 30_000;
/** Who an observed signal is from: the owner's own app (the bus only carries owner actions). */
const APP = { sender: { kind: "device", deviceId: "app" }, surface: "app" } as const;

export function composeTeaching(deps: TeachingComposeDeps): ComposedTeaching {
  const { db } = deps;
  const store = new TeachingStore({ sqlite: db.sqlite, clock: deps.clock });
  const writer = new LessonWriter({
    memory: deps.memory,
    ...(deps.graph === undefined ? {} : { graph: deps.graph }),
    scheduler: deps.scheduler,
    askRules: deps.askRules,
  });
  let growthTimer: ReturnType<typeof setTimeout> | undefined;
  const growthChanged = () => {
    // Coarse and debounced (§7): clients re-read growth.summary when the view is open.
    if (growthTimer !== undefined) return;
    growthTimer = setTimeout(() => {
      growthTimer = undefined;
      deps.publish("growth.updated", {});
    }, 2_000);
    growthTimer.unref?.();
  };
  const service = new TeachingService({
    store,
    writer,
    broker: deps.broker,
    ...(deps.active ? { provider: deps.provider, model: deps.model } : {}),
    clock: deps.clock,
    settings: () => teachingSettings(db),
    surfaces: deps.surfaces,
    audit: deps.audit,
    ...(deps.graph === undefined ? {} : { resolveEntity: graphEntityResolver(deps.graph) }),
    appliedLessons: (target) =>
      target.type === "message"
        ? (getMessage(db, target.id)?.lessonsApplied ?? []).map((l) => l.lessonId)
        : [],
    onFeedback: (event) => {
      deps.publish("feedback.recorded", { event }, event.target.threadId);
      growthChanged();
    },
    onLesson: (lesson) => {
      deps.publish("lesson.changed", { lessonId: lesson.id, status: lesson.status, lesson });
      growthChanged();
    },
  });

  const routerTarget = async (target: FeedbackTarget): Promise<RouterTarget> => {
    const out: RouterTarget = {};
    if (target.type === "message") {
      const m = messageText(db, target.id);
      if (m !== undefined && m.text !== "") {
        out.excerpt = m.text;
        // The agent's answer may quote what it read: never a lesson by itself.
        out.excerptUntrusted = !m.owner;
      }
    }
    if (target.skill !== undefined) out.skill = target.skill;
    if (target.automationId !== undefined) {
      const a = await deps.scheduler.get(target.automationId);
      if (a !== undefined) {
        out.automation = { id: a.id, title: a.title, schedule: a.schedule, timezone: a.timezone };
      }
    }
    return out;
  };

  /** "Psyche will remember: …" under the message the owner corrected (§5.1). */
  const taught = (
    target: FeedbackTarget,
    feedbackId: string,
    lessonId: string | null,
    statement: string | null,
  ) => {
    if (target.type !== "message" || target.threadId === undefined) return;
    if (getThread(db, target.threadId) === undefined) return;
    const block: Block = { type: "taught", feedbackId, lessonId, statement, messageId: target.id };
    try {
      const message = appendMessage(
        db,
        {
          threadId: target.threadId,
          role: "system",
          blocks: [block],
          provenance: "agent",
          runId: null,
        },
        { expectedWriterRunId: null },
      );
      deps.publish("chat.message", { message }, target.threadId);
    } catch {
      // A run holds the transcript: the result still carries the lesson, the UI shows it there.
    }
  };

  const handlers: Record<string, HandlerDef> = {
    "feedback.give": {
      run: async (call: Call, params: MethodParams<"feedback.give">) => {
        // The thread the target really lives in (a message names its own), never only the
        // client's word for it: incognito threads never teach.
        const threadId =
          (params.target.type === "message"
            ? getMessage(db, params.target.id)?.threadId
            : undefined) ?? params.target.threadId;
        const thread = threadId === undefined ? undefined : getThread(db, threadId);
        const result = await service.give(
          {
            target: params.target,
            kind: params.kind,
            ...(params.text === undefined ? {} : { text: params.text }),
            ...(params.reason === undefined ? {} : { reason: params.reason }),
            ...(params.scope === undefined ? {} : { scope: params.scope }),
          },
          {
            sender: { kind: "device", deviceId: call.identity.deviceId },
            surface: surfaceOf(db, call.identity.deviceId),
            incognito: thread?.kind === "incognito",
            target: await routerTarget(params.target),
          },
        );
        if (params.kind !== "helpful") {
          taught(
            params.target,
            result.event.id,
            result.lesson?.id ?? null,
            result.lesson?.statement ?? null,
          );
        }
        return result satisfies MethodResult<"feedback.give">;
      },
    },
    "feedback.list": {
      run: (_call: Call, params: MethodParams<"feedback.list">) => {
        const page = store.listEvents({
          ...(params.since === undefined ? {} : { since: params.since }),
          ...(params.kind === undefined ? {} : { kind: params.kind }),
          ...(params.targetType === undefined ? {} : { targetType: params.targetType }),
          ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        });
        return {
          events: page.events,
          nextCursor: page.nextCursor,
        } satisfies MethodResult<"feedback.list">;
      },
    },
    "feedback.delete": {
      run: async (_call: Call, params: MethodParams<"feedback.delete">) => {
        await service.deleteEvent(params.eventId);
        return { ok: true as const };
      },
    },
    "memory.lessons.list": {
      run: (_call: Call, params: MethodParams<"memory.lessons.list">) => {
        const page = store.listLessons({
          ...(params.status === undefined ? {} : { status: params.status }),
          ...(params.kind === undefined ? {} : { kind: params.kind }),
          ...(params.destination === undefined ? {} : { destination: params.destination }),
          ...(params.since === undefined ? {} : { since: params.since }),
          ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        });
        return {
          lessons: page.lessons.map(publicLesson),
          nextCursor: page.nextCursor,
        } satisfies MethodResult<"memory.lessons.list">;
      },
    },
    "memory.lessons.get": {
      run: (_call: Call, params: MethodParams<"memory.lessons.get">) =>
        service.get(params.lessonId),
    },
    "memory.lessons.confirm": {
      run: (_call: Call, params: MethodParams<"memory.lessons.confirm">) => ({
        lesson: service.confirm(params.lessonId),
      }),
    },
    "memory.lessons.edit": {
      run: (_call: Call, params: MethodParams<"memory.lessons.edit">) => {
        return service.edit(params.lessonId, params.value);
      },
    },
    "memory.lessons.forget": {
      run: async (_call: Call, params: MethodParams<"memory.lessons.forget">) => {
        return {
          lesson: await service.forget(params.lessonId, {
            ...(params.purgeSources === undefined ? {} : { purgeSources: params.purgeSources }),
          }),
        };
      },
    },
  };

  const observeApproval = (a: ApprovalRequest) => {
    // Lesson cards are the loop itself, and plan approvals are not about a proposal's quality.
    if (a.fromLesson !== undefined || a.kind === "plan_exit") return;
    if (a.status !== "approved" && a.status !== "denied") return;
    const by = a.decidedBy;
    if (by == null) return;
    const widest = Math.max(...a.scopesOffered.map((s) => SCOPE_RANK[s]));
    const chosen = a.scopeGranted == null ? 0 : SCOPE_RANK[a.scopeGranted];
    const kind =
      a.status === "denied" ? "approval_denied" : chosen < widest ? "approval_edited" : undefined;
    if (kind === undefined) return;
    const threadId = a.requestedBy.threadId ?? undefined;
    const thread = threadId === undefined ? undefined : getThread(db, threadId);
    const sender =
      "deviceId" in by
        ? ({ kind: "device", deviceId: by.deviceId } as const)
        : ({ kind: "channel", role: "owner", isGroup: false } as const);
    const surface = "deviceId" in by ? (by.surface ?? "desktop") : `channel:${by.channel}`;
    void service
      .give(
        {
          target: {
            type: "approval",
            id: a.id,
            ...(threadId === undefined ? {} : { threadId }),
            ...(a.requestedBy.taskId == null ? {} : { taskId: a.requestedBy.taskId }),
          },
          kind,
          detail:
            kind === "approval_denied"
              ? { approvalKind: a.kind }
              : {
                  approvalKind: a.kind,
                  offered: a.scopesOffered,
                  chosen: a.scopeGranted ?? "once",
                },
        },
        { sender, surface, incognito: thread?.kind === "incognito" },
      )
      .catch(() => undefined); // switched off, paused or incognito: nothing recorded
  };

  handlers["growth.summary"] = {
    run: async (_call: Call, params: MethodParams<"growth.summary">) => {
      const approvals = await deps.broker.list();
      const tasks = (await deps.tasks.list()) as Task[];
      const automations = db.sqlite
        .prepare("SELECT id, title, created_at, system FROM automations")
        .all() as { id: string; title: string; created_at: string; system: number }[];
      const started = db.sqlite.prepare("SELECT MIN(created_at) AS at FROM threads").get() as {
        at: string | null;
      };
      const summary = computeGrowth(params.window, {
        now: deps.clock.now(),
        events: store.allEvents(),
        lessons: store.allLessons(),
        weekly: store.weekly(),
        approvals: approvals.map((a) => ({
          id: a.id,
          kind: a.kind,
          status: a.status,
          decidedAt: a.decidedAt ?? null,
          scopesOffered: a.scopesOffered,
          scopeGranted: a.scopeGranted ?? null,
          ...(a.fromLesson === undefined ? {} : { fromLesson: a.fromLesson }),
        })),
        tasks: tasks.map((t) => ({
          id: t.id,
          status: t.status,
          completedAt: t.completedAt ?? null,
        })),
        automations: automations.map((a) => ({
          id: a.id,
          title: a.title,
          createdAt: a.created_at,
          system: a.system === 1,
        })),
        startedAt: started.at,
      });
      return { summary } satisfies MethodResult<"growth.summary">;
    },
  };
  // Presence-gated in `presence-gate.ts` like memory.reset; a dry run only counts.
  handlers["memory.lessons.forgetAll"] = {
    run: async (_call: Call, params: MethodParams<"memory.lessons.forgetAll">) => {
      const dryRun = params.dryRun === true;
      const r = await service.forgetAll({ dryRun });
      if (!dryRun) growthChanged();
      return { ...r, dryRun } satisfies MethodResult<"memory.lessons.forgetAll">;
    },
  };

  /** Records an observed signal once; switched-off, paused or incognito ones are dropped. */
  const observe = (
    kind: "undo" | "feed" | "idea" | "regenerated",
    target: FeedbackTarget,
    detail: Record<string, unknown> | undefined,
    text?: string,
    sender: { kind: "device"; deviceId: string } = APP.sender,
    surface: string = APP.surface,
  ) => {
    const thread = target.threadId === undefined ? undefined : getThread(db, target.threadId);
    void service
      .give(
        {
          target,
          kind,
          ...(text === undefined ? {} : { text }),
          ...(detail === undefined ? {} : { detail }),
        },
        { sender, surface, incognito: thread?.kind === "incognito" },
      )
      .catch(() => undefined);
  };

  /** The same signal on the same target is recorded once (events can repeat on the bus). */
  const seen = (type: FeedbackTarget["type"], id: string, key: string): boolean => {
    const last = store.listEvents({ targetType: type, targetId: id, limit: 1 }).events[0];
    return last !== undefined && JSON.stringify(last.detail ?? {}).includes(key);
  };

  const onLearnedUndo = (factId: string, threadId: string | undefined) => {
    // The "Learned: …" note the fact was shown in, when it is still there.
    const note =
      threadId === undefined
        ? undefined
        : listMessagesPage(db, threadId, { limit: 200 }).messages.find((m) =>
            m.blocks.some((b) => b.type === "learned" && b.items.some((i) => i.factId === factId)),
          );
    observe(
      "undo",
      {
        type: "message",
        id: note?.id ?? factId,
        ...(threadId === undefined ? {} : { threadId }),
      },
      { what: "learned_fact", factId },
    );
  };

  const onFrame = (frame: string) => {
    let f: { event?: string; payload?: Record<string, unknown> };
    try {
      f = JSON.parse(frame) as typeof f;
    } catch {
      return;
    }
    if (f.event === "task.updated") {
      const task = f.payload?.task as Task | undefined;
      if (task?.status !== "cancelled") return;
      const took = Date.parse(task.updatedAt) - Date.parse(task.createdAt);
      if (!(took >= 0 && took <= QUICK_CANCEL_MS) || seen("task", task.id, "quick_cancel")) return;
      observe(
        "undo",
        { type: "task", id: task.id, threadId: task.threadId, taskId: task.id },
        { what: "quick_cancel", afterMs: took },
      );
    } else if (f.event === "feed.post") {
      const post = f.payload?.post as FeedPost | undefined;
      if (post?.feedback == null || seen("feed_post", post.id, `"${post.feedback}"`)) return;
      observe("feed", { type: "feed_post", id: post.id }, { feedback: post.feedback });
    } else if (f.event === "idea.updated") {
      const idea = f.payload?.idea as Idea | undefined;
      if (idea?.status !== "dismissed" || seen("idea", idea.id, '"dismissed"')) return;
      observe("idea", { type: "idea", id: idea.id }, { status: "dismissed", kind: idea.kind });
    }
  };

  const onRedo = (redo: ChatRedo) => {
    // A redo with the owner's instruction ("shorter") is feedback on the redone message (0.6).
    if (redo.instruction === undefined) return;
    observe(
      "regenerated",
      { type: "message", id: redo.messageId, threadId: redo.threadId },
      redo.withoutLessons === true ? { withoutLessons: true } : undefined,
      redo.instruction,
      { kind: "device", deviceId: redo.deviceId },
      surfaceOf(db, redo.deviceId),
    );
  };

  let unsubscribe: (() => void) | undefined;
  let gatewayRef: Gateway | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const part: ComposedPart = {
    start(gateway: Gateway) {
      gatewayRef = gateway;
      unsubscribe = gateway.bus.subscribe(["operator.read"], onFrame);
      gateway.context.chatRedo.add(onRedo);
      service.retain();
      const every = deps.retentionIntervalMs ?? 24 * 3_600_000;
      if (every > 0) {
        timer = setInterval(() => service.retain(), every);
        timer.unref?.();
      }
    },
    stop() {
      unsubscribe?.();
      gatewayRef?.context.chatRedo.delete(onRedo);
      if (timer !== undefined) clearInterval(timer);
      if (growthTimer !== undefined) clearTimeout(growthTimer);
    },
  };

  return {
    service,
    handlers,
    observeApproval,
    resume: () => service.resume(),
    onLearnedUndo,
    part,
  };
}

/**
 * Boundary lessons' standing `ask` rules in `permissions.policy` (§4 `boundary`). Only rules the
 * teaching loop added are ever removed: a rule the owner wrote stays when a lesson is forgotten.
 */
export const TEACHING_ASK_RULES_KEY = "teaching.askRules";

export function teachingAskRules(options: {
  db: PsycheDb;
  read: () => { ask?: string[] } & Record<string, unknown>;
  write: (next: { ask?: string[] } & Record<string, unknown>) => void;
  setOwned: (rules: string[]) => void;
  owned: () => string[];
}): AskRules {
  return {
    add: async (rule) => {
      const policy = options.read();
      const ask = policy.ask ?? [];
      if (ask.includes(rule)) return; // the owner's own rule: not ours to remove later
      options.write({ ...policy, ask: [...ask, rule] });
      options.setOwned([...new Set([...options.owned(), rule])]);
    },
    remove: async (rule) => {
      if (!options.owned().includes(rule)) return;
      const policy = options.read();
      options.write({ ...policy, ask: (policy.ask ?? []).filter((r) => r !== rule) });
      options.setOwned(options.owned().filter((r) => r !== rule));
    },
  };
}
