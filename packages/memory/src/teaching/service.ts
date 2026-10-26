import { createHash } from "node:crypto";
import type {
  ApprovalRequest,
  AuditLog,
  Clock,
  FeedbackEvent,
  FeedbackKind,
  FeedbackReason,
  FeedbackScope,
  FeedbackTarget,
  Lesson,
  LessonDestination,
  ModelProvider,
  ModelRef,
  PermissionBroker,
  Surface,
  TeachingImplicitSignals,
} from "@psyche/protocol";
import { PsycheError, TEACHING_SETTING_DEFAULTS } from "@psyche/protocol";
import { blockingKinds, looksLikeInstruction } from "../filters.ts";
import { CONFIDENCE, confidenceFor, HELPFUL_BOOST, mayTeach } from "./confidence.ts";
import {
  alwaysAsks,
  type ExistingLesson,
  type PlannedDestination,
  type PlannedLesson,
  parseRouterReply,
  planLesson,
  ROUTER_SYSTEM,
  type RouterTarget,
  routerMessage,
} from "./router.ts";
import {
  destinationKey,
  LIVE_STATUSES,
  normalizeLessonText,
  type StoredLesson,
  type TeachingStore,
} from "./store.ts";
import type { LessonWriter } from "./writers.ts";

/**
 * The teaching loop's Gateway side (docs/agent/teaching-loop-2026.md §3–4): records the owner's
 * feedback, runs the router on explicit feedback, and writes the lesson where it belongs, either
 * at once (USER.md and the graph under `memory.userProfile.review: auto`) or after a
 * `memory_protected_write` card (SOUL.md, AGENTS.md, skills, automations, boundaries, and
 * everything under `review: ask`). Feedback is the owner's alone; nothing from content the agent
 * read, a delegated person or a group, or an incognito thread ever becomes a lesson.
 */

export interface TeachingSettings {
  enabled: boolean;
  paused: boolean;
  implicit: TeachingImplicitSignals;
  /** Teaching surfaces switched off by the owner (`chat`, `email_drafts`, `feed`, …). */
  surfaces: Record<string, boolean>;
  /** `memory.userProfile.review`: whether USER.md and graph corrections ask first. */
  review: "auto" | "ask";
}

export const DEFAULT_TEACHING_SETTINGS: TeachingSettings = {
  enabled: TEACHING_SETTING_DEFAULTS["teaching.enabled"],
  paused: TEACHING_SETTING_DEFAULTS["teaching.paused"],
  implicit: { ...TEACHING_SETTING_DEFAULTS["teaching.implicit"] },
  surfaces: {},
  review: "auto",
};

/** Who gave the feedback. Only the owner teaches (§3.1 `provenance: owner`). */
export type FeedbackSender =
  | { kind: "device"; deviceId: string }
  | { kind: "channel"; role: "owner" | "designated" | "allowed"; isGroup: boolean };

export interface FeedbackContext {
  sender: FeedbackSender;
  /** `desktop`, `web` or `channel:<id>`. */
  surface: string;
  /** The target's thread is incognito: refused (incognito never teaches). */
  incognito?: boolean;
  /** What the feedback is about, for the router (quoted as data). */
  target?: RouterTarget;
}

export interface GiveInput {
  target: FeedbackTarget;
  kind: FeedbackKind;
  text?: string | undefined;
  reason?: FeedbackReason | undefined;
  scope?: FeedbackScope | undefined;
  detail?: Record<string, unknown> | undefined;
}

export interface GiveResult {
  event: FeedbackEvent;
  lesson: Lesson | null;
  approval: ApprovalRequest | null;
}

export interface TeachingServiceDeps {
  store: TeachingStore;
  writer: LessonWriter;
  broker: Pick<PermissionBroker, "requestApproval" | "awaitDecision" | "verifyBinding" | "get">;
  /** The utility model; without one feedback is recorded but never routed. */
  provider?: ModelProvider;
  model?: ModelRef;
  clock: Clock;
  settings: () => TeachingSettings;
  /** Approval surfaces for lesson cards (devices only: lessons are the owner's to approve). */
  surfaces: Surface[];
  audit?: Pick<AuditLog, "append">;
  /** A person or project in the graph by name or address. */
  resolveEntity?: (nameOrAddress: string) => string | undefined;
  /** Lessons a target's answer used (`lessonsApplied`), for "helpful". */
  appliedLessons?: (target: FeedbackTarget) => string[];
  onFeedback?: (event: FeedbackEvent) => void;
  onLesson?: (lesson: Lesson) => void;
}

/** The teaching surface a target belongs to (`teaching.surfaces`). */
export function teachingSurface(target: FeedbackTarget): string {
  switch (target.type) {
    case "draft":
      return "email_drafts";
    case "feed_post":
      return "feed";
    case "idea":
      return "ideas";
    default:
      return "chat";
  }
}

/** The implicit switch an implicit kind is governed by (`teaching.implicit`). */
function implicitSwitch(kind: FeedbackKind): keyof TeachingImplicitSignals | undefined {
  switch (kind) {
    case "draft_edited":
      return "draftEdits";
    case "undo":
      return "undo";
    case "approval_edited":
    case "approval_denied":
      return "approvalEdits";
    case "dismissed":
      return "dismissals";
    default:
      return undefined;
  }
}

export function lessonBinding(lessonId: string, destination: unknown, value: string): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(["psyche.lesson.v1", lessonId, destination, value]))
    .digest("hex")}`;
}

/** The public shape (drops the store's bookkeeping columns). */
export function publicLesson(l: StoredLesson): Lesson {
  const { approvalId: _a, lastConfirmedAt: _c, updatedAt: _u, ...lesson } = l;
  return lesson;
}

function fail(code: PsycheError["code"], message: string): never {
  throw new PsycheError(code, message);
}

function plannedFrom(destination: LessonDestination): PlannedDestination {
  switch (destination.type) {
    case "file":
      return {
        type: "file",
        path: destination.path as "SOUL.md" | "USER.md" | "AGENTS.md",
        section: destination.section,
      };
    case "skill":
      return { type: "skill", skill: destination.skill, path: destination.path };
    case "graph":
      return {
        type: "graph",
        entityId: destination.entityId,
        ...(destination.attribute === undefined
          ? {}
          : { attribute: destination.attribute as never }),
        ...(destination.rel === undefined ? {} : { rel: destination.rel as never }),
      };
    case "automation":
      return {
        type: "automation",
        automationId: destination.automationId,
        field: destination.field as never,
      };
  }
}

interface Pending {
  plan: PlannedLesson;
  threadId?: string | undefined;
  replaces?: StoredLesson | undefined;
}

export class TeachingService {
  readonly #d: TeachingServiceDeps;
  /** Plans waiting on a card, by lesson id (re-derived from the row after a restart). */
  readonly #pending = new Map<string, Pending>();
  #inflight = new Set<Promise<unknown>>();

  constructor(deps: TeachingServiceDeps) {
    this.#d = deps;
  }

  get store(): TeachingStore {
    return this.#d.store;
  }

  /** Background work (cards being awaited, writes after approval); tests await it. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  #track<T>(p: Promise<T>): Promise<T> {
    this.#inflight.add(p);
    void p.catch(() => undefined).finally(() => this.#inflight.delete(p));
    return p;
  }

  #now(): string {
    return new Date(this.#d.clock.now()).toISOString();
  }

  #audit(kind: string, data: Record<string, unknown>): void {
    void this.#d.audit
      ?.append({ kind, actor: { type: "user" }, subject: {}, data } as never)
      .catch(() => undefined);
  }

  #changed(lesson: StoredLesson): void {
    this.#d.onLesson?.(publicLesson(lesson));
  }

  /** Throws unless this feedback may be recorded at all. */
  #admit(kind: FeedbackKind, target: FeedbackTarget, ctx: FeedbackContext): void {
    const s = ctx.sender;
    if (s.kind === "channel" && (s.role !== "owner" || s.isGroup)) {
      fail("forbidden", "only the owner's own feedback teaches Psyche");
    }
    if (ctx.incognito === true) fail("policy_denied", "incognito chats never teach Psyche");
    const settings = this.#d.settings();
    if (!settings.enabled) fail("policy_denied", "learning from feedback is off");
    if (settings.paused) fail("policy_denied", "learning is paused");
    if (settings.surfaces[teachingSurface(target)] === false) {
      fail("policy_denied", "learning from this surface is off");
    }
    const sw = implicitSwitch(kind);
    if (sw !== undefined && !settings.implicit[sw]) {
      fail("policy_denied", "this signal is switched off");
    }
  }

  /**
   * Feedback from the owner (`feedback.give`, and the Gateway's implicit signals). Explicit
   * corrections run the router; "helpful" only confirms lessons the answer used; implicit kinds
   * stay evidence.
   */
  async give(input: GiveInput, ctx: FeedbackContext): Promise<GiveResult> {
    this.#admit(input.kind, input.target, ctx);
    const event = this.#d.store.recordEvent({
      kind: input.kind,
      target: input.target,
      text: input.text ?? null,
      reason: input.reason ?? null,
      scope: input.scope ?? null,
      detail: input.detail ?? null,
      surface: ctx.surface,
    });
    this.#d.onFeedback?.(event);
    this.#audit("teaching.feedback.recorded", { eventId: event.id, kind: event.kind });

    if (event.kind === "helpful") {
      this.#helpful(event);
      return { event, lesson: null, approval: null };
    }
    if (!mayTeach(event) || this.#d.provider === undefined || this.#d.model === undefined) {
      return { event, lesson: null, approval: null };
    }
    const proposals = await this.#route(event, ctx.target ?? {});
    let first: { lesson: StoredLesson; approval: ApprovalRequest | null } | undefined;
    for (const p of proposals) {
      const planned = planLesson(p, {
        ownerText: [event.text ?? "", event.reason ?? ""].join(" "),
        target: ctx.target ?? {},
        chip: event.scope ?? null,
        ...(this.#d.resolveEntity === undefined ? {} : { resolveEntity: this.#d.resolveEntity }),
      });
      if ("refused" in planned) {
        this.#audit("teaching.lesson.refused", { eventId: event.id, reason: planned.refused });
        continue;
      }
      const replaces = this.#replaced(p.replaces, planned.plan);
      const made = await this.#make(event, planned.plan, replaces);
      if (made !== undefined && first === undefined) first = made;
    }
    const latest = this.#d.store.getEvent(event.id) ?? event;
    return {
      event: latest,
      lesson: first === undefined ? null : publicLesson(first.lesson),
      approval: first?.approval ?? null,
    };
  }

  async #route(event: FeedbackEvent, target: RouterTarget) {
    const existing: ExistingLesson[] = this.#d.store
      .listLessons({ status: LIVE_STATUSES, limit: 20 })
      .lessons.map((l) => ({ id: l.id, kind: l.kind, statement: l.statement }));
    let out = "";
    try {
      for await (const e of (this.#d.provider as ModelProvider).stream(
        {
          model: this.#d.model as ModelRef,
          system: ROUTER_SYSTEM,
          messages: [
            {
              role: "user",
              parts: [{ type: "text", text: routerMessage(event, target, existing) }],
            },
          ],
        },
        {},
      )) {
        if (e.type === "text_delta") out += e.text;
      }
    } catch {
      return [];
    }
    return parseRouterReply(out);
  }

  /** The live lesson the router says this one replaces, if it really is on the same destination. */
  #replaced(id: string | undefined, plan: PlannedLesson): StoredLesson | undefined {
    const key = destinationKey(plan.destination as LessonDestination, plan.scope);
    const named = id === undefined ? undefined : this.#d.store.getLesson(id);
    if (
      named !== undefined &&
      LIVE_STATUSES.includes(named.status) &&
      destinationKey(named.destination, named.scope) === key
    ) {
      return named;
    }
    // A single-valued destination (an automation field, a graph attribute) always supersedes.
    if (plan.destination.type === "automation" || plan.destination.type === "graph") {
      return this.#d.store.currentOn(plan.destination as LessonDestination, plan.scope);
    }
    return undefined;
  }

  async #make(
    event: FeedbackEvent,
    plan: PlannedLesson,
    replaces: StoredLesson | undefined,
  ): Promise<{ lesson: StoredLesson; approval: ApprovalRequest | null } | undefined> {
    const store = this.#d.store;
    const dest = plan.destination as LessonDestination;
    if (store.isTombstoned(plan.kind, dest, plan.scope, plan.value)) {
      this.#audit("teaching.lesson.refused", { eventId: event.id, reason: "forgotten_before" });
      return undefined;
    }
    // The same lesson again (a repeat correction): one more source, no new line.
    const norm = normalizeLessonText(plan.value);
    const same = store
      .listLessons({ status: LIVE_STATUSES, limit: 200 })
      .lessons.find(
        (l) =>
          destinationKey(l.destination, l.scope) === destinationKey(dest, plan.scope) &&
          normalizeLessonText(l.value) === norm,
      );
    if (same !== undefined) {
      const updated = store.updateLesson(same.id, {
        sources: [...new Set([...same.sources, event.id])].slice(-50),
        confidence: Math.max(same.confidence, confidenceFor(event) ?? 0),
      });
      store.linkEvent(event.id, same.id);
      this.#changed(updated);
      return { lesson: updated, approval: null };
    }

    const confidence = confidenceFor(event) ?? CONFIDENCE.feedback;
    const lesson = store.insertLesson({
      kind: plan.kind,
      origin: "stated",
      statement: plan.statement,
      scope: plan.scope,
      // A placeholder line id until the writer assigns the real one.
      destination: withLineId(plan.destination, "pending"),
      previous: null,
      value: plan.value,
      sources: [event.id],
      confidence,
      status: "proposed",
      refinedCount: replaces === undefined ? 0 : replaces.refinedCount + 1,
      supersedes: replaces?.id ?? null,
    });
    store.linkEvent(event.id, lesson.id);
    const pending: Pending = { plan, threadId: event.target.threadId, replaces };

    const settings = this.#d.settings();
    const askFirst =
      alwaysAsks(plan.kind, plan.destination) ||
      ((plan.destination.type === "graph" ||
        (plan.destination.type === "file" && plan.destination.path === "USER.md")) &&
        settings.review === "ask");
    if (!askFirst) {
      const written = await this.#write(lesson, pending);
      if (written === undefined) {
        store.deleteLesson(lesson.id);
        store.linkEvent(event.id, null);
        return undefined;
      }
      return { lesson: written, approval: null };
    }

    const preview = await this.#d.writer.preview({
      lessonId: lesson.id,
      kind: plan.kind,
      scope: plan.scope,
      value: plan.value,
      destination: plan.destination,
      replaces,
    });
    const target = plan.destination;
    const path =
      target.type === "file" || target.type === "skill"
        ? target.path
        : target.type === "graph"
          ? `graph:${target.entityId}`
          : `automation:${target.automationId}`;
    const binding = lessonBinding(lesson.id, target, plan.value);
    const issued = await this.#d.broker.requestApproval({
      kind: "memory_protected_write",
      summary: summaryFor(plan),
      details: {
        path,
        operation: "lesson",
        lessonId: lesson.id,
        kind: plan.kind,
        statement: plan.statement,
        diff: { before: preview.before, after: preview.after },
        ...(plan.askRule === undefined ? {} : { askRule: plan.askRule }),
      },
      bindingHash: binding,
      grantKey: binding,
      requestedBy: {
        runId: null,
        taskId: event.target.taskId ?? null,
        threadId: event.target.threadId ?? null,
      },
      sideEffect: "write",
      surfaces: this.#d.surfaces,
      scopesOffered: ["once"],
      taint: false,
      fromLesson: {
        lessonId: lesson.id,
        feedbackId: event.id,
        because: (event.text ?? event.reason ?? "").slice(0, 500),
      },
    });
    const proposed = store.updateLesson(lesson.id, { approvalId: issued.approval.id });
    this.#pending.set(lesson.id, pending);
    this.#changed(proposed);
    void this.#track(this.#awaitCard(lesson.id, issued.approval.id, binding));
    return { lesson: proposed, approval: issued.approval };
  }

  async #awaitCard(lessonId: string, approvalId: string, binding: string): Promise<void> {
    let status: string;
    try {
      status = (await this.#d.broker.awaitDecision(approvalId)).status;
    } catch {
      status = "invalidated";
    }
    await this.#settle(lessonId, approvalId, binding, status);
  }

  async #settle(lessonId: string, approvalId: string, binding: string, status: string) {
    const store = this.#d.store;
    const lesson = store.getLesson(lessonId);
    // Forgotten (or already settled) while the card was open: nothing to write.
    if (lesson === undefined || lesson.status !== "proposed" || lesson.approvalId !== approvalId) {
      this.#pending.delete(lessonId);
      return;
    }
    if (status !== "approved") {
      // "Not now": kept out of the prompt, offered again by the weekly card (T3).
      this.#changed(store.updateLesson(lessonId, { status: "dormant", approvalId: null }));
      this.#pending.delete(lessonId);
      return;
    }
    const verified = await this.#d.broker.verifyBinding(approvalId, binding);
    if (!verified.ok) {
      this.#changed(store.updateLesson(lessonId, { status: "dormant", approvalId: null }));
      this.#pending.delete(lessonId);
      return;
    }
    const pending = this.#pending.get(lessonId) ?? this.#rederive(lesson);
    this.#pending.delete(lessonId);
    const written = await this.#write(lesson, pending);
    if (written === undefined) {
      this.#changed(store.updateLesson(lessonId, { status: "dormant", approvalId: null }));
    }
  }

  #rederive(lesson: StoredLesson): Pending {
    const replaces =
      lesson.supersedes == null ? undefined : this.#d.store.getLesson(lesson.supersedes);
    const askRule =
      lesson.kind === "boundary" && typeof lesson.scope.recipient === "string"
        ? `recipient:${lesson.scope.recipient}`
        : undefined;
    return {
      plan: {
        kind: lesson.kind,
        statement: lesson.statement,
        value: lesson.value,
        scope: lesson.scope,
        destination: plannedFrom(lesson.destination),
        ...(askRule === undefined ? {} : { askRule }),
      },
      replaces,
    };
  }

  /**
   * Gateway boot: lessons whose card is still pending are awaited again; approved ones are
   * written; cards a restart invalidated leave their lesson dormant for the weekly card.
   */
  async resume(): Promise<void> {
    const proposed = this.#d.store.listLessons({ status: ["proposed"], limit: 200 }).lessons;
    for (const l of proposed) {
      if (l.approvalId === null) continue;
      const binding = lessonBinding(l.id, plannedFrom(l.destination), l.value);
      const a = await this.#d.broker.get(l.approvalId);
      if (a?.status === "pending") {
        void this.#track(this.#awaitCard(l.id, l.approvalId, binding));
      } else {
        await this.#settle(l.id, l.approvalId, binding, a?.status ?? "invalidated");
      }
    }
  }

  /** Writes a lesson at its destination and makes it active; `undefined` when refused there. */
  async #write(lesson: StoredLesson, pending: Pending): Promise<StoredLesson | undefined> {
    const store = this.#d.store;
    const { plan, replaces } = pending;
    let r: Awaited<ReturnType<LessonWriter["write"]>>;
    try {
      r = await this.#d.writer.write({
        lessonId: lesson.id,
        kind: plan.kind,
        scope: plan.scope,
        value: plan.value,
        destination: plan.destination,
        replaces:
          replaces !== undefined && LIVE_STATUSES.includes(replaces.status) ? replaces : undefined,
        threadId: pending.threadId,
        askRule: plan.askRule,
      });
    } catch (err) {
      // The destination refused it (an invalid schedule, a conflict): nothing was learned.
      r = { ok: false, reason: (err as { code?: string }).code ?? "write_failed" };
    }
    if (!r.ok) {
      this.#audit("teaching.lesson.refused", { lessonId: lesson.id, reason: r.reason });
      return undefined;
    }
    if (replaces !== undefined && LIVE_STATUSES.includes(replaces.status)) {
      this.#changed(store.updateLesson(replaces.id, { status: "superseded" }));
    }
    const active = store.updateLesson(lesson.id, {
      status: "active",
      destination: r.destination,
      previous: r.previous,
      value: r.value,
      approvalId: null,
    });
    this.#audit("teaching.lesson.written", {
      lessonId: lesson.id,
      kind: lesson.kind,
      destination: r.destination.type,
      ...(replaces === undefined ? {} : { supersedes: replaces.id }),
    });
    this.#changed(active);
    return active;
  }

  #helpful(event: FeedbackEvent): void {
    for (const id of this.#d.appliedLessons?.(event.target) ?? []) {
      const l = this.#d.store.getLesson(id);
      if (l === undefined || !LIVE_STATUSES.includes(l.status)) continue;
      const updated = this.#d.store.updateLesson(id, {
        confidence: Math.min(CONFIDENCE.confirmed, l.confidence + HELPFUL_BOOST),
        sources: [...new Set([...l.sources, event.id])].slice(-50),
      });
      this.#changed(updated);
    }
  }

  // --- memory.lessons.* -----------------------------------------------------------------------

  #lesson(id: string): StoredLesson {
    const l = this.#d.store.getLesson(id);
    if (l === undefined) fail("not_found", `lesson ${id} not found`);
    return l;
  }

  async get(lessonId: string) {
    const lesson = this.#lesson(lessonId);
    const current =
      lesson.status === "forgotten" || lesson.status === "proposed"
        ? undefined
        : await this.#d.writer.current(lesson);
    return {
      lesson: publicLesson(lesson),
      sources: this.#d.store.eventsFor(lesson.sources),
      diff: { before: lesson.previous ?? null, after: current ?? lesson.value },
      history: this.#d.store.history(lessonId).map(publicLesson),
    };
  }

  confirm(lessonId: string): Lesson {
    const lesson = this.#lesson(lessonId);
    if (!["active", "confirmed", "dormant"].includes(lesson.status)) {
      fail("conflict", `a ${lesson.status} lesson cannot be confirmed`);
    }
    if (lesson.status === "dormant" && lesson.destination.type !== "automation") {
      // Dormant lines may have been removed; only a live line is confirmed in place.
    }
    const now = this.#now();
    const updated = this.#d.store.updateLesson(lessonId, {
      confidence: CONFIDENCE.confirmed,
      status: lesson.status === "dormant" ? lesson.status : "confirmed",
      confirmedAt: now,
      lastConfirmedAt: now,
    });
    this.#audit("teaching.lesson.confirmed", { lessonId });
    this.#changed(updated);
    return publicLesson(updated);
  }

  async edit(
    lessonId: string,
    value: string,
  ): Promise<{ lesson: Lesson; approval: ApprovalRequest | null }> {
    const lesson = this.#lesson(lessonId);
    if (!LIVE_STATUSES.includes(lesson.status)) {
      fail("conflict", `a ${lesson.status} lesson cannot be edited`);
    }
    const text = value.replace(/\s+/g, " ").trim();
    if (text === "") fail("invalid_params", "a lesson needs a value");
    if (looksLikeInstruction(text) || blockingKinds(text, false).length > 0) {
      fail("policy_denied", "that line can't be saved as a lesson");
    }
    if (alwaysAsks(lesson.kind, lesson.destination)) {
      const binding = lessonBinding(lesson.id, lesson.destination, text);
      const issued = await this.#d.broker.requestApproval({
        kind: "memory_protected_write",
        summary: `Change a lesson: ${text}`.slice(0, 300),
        details: {
          path:
            lesson.destination.type === "file" || lesson.destination.type === "skill"
              ? lesson.destination.path
              : lesson.destination.type,
          operation: "lesson_edit",
          lessonId,
          diff: { before: lesson.value, after: text },
        },
        bindingHash: binding,
        grantKey: binding,
        requestedBy: { runId: null, taskId: null, threadId: null },
        sideEffect: "write",
        surfaces: this.#d.surfaces,
        scopesOffered: ["once"],
        taint: false,
        fromLesson: { lessonId, feedbackId: lesson.sources.at(-1) ?? lessonId, because: text },
      });
      void this.#track(
        (async () => {
          const a = await this.#d.broker.awaitDecision(issued.approval.id).catch(() => undefined);
          if (a?.status !== "approved") return;
          const v = await this.#d.broker.verifyBinding(issued.approval.id, binding);
          if (v.ok) await this.#rewrite(lessonId, text);
        })(),
      );
      return { lesson: publicLesson(lesson), approval: issued.approval };
    }
    return { lesson: await this.#rewrite(lessonId, text), approval: null };
  }

  async #rewrite(lessonId: string, value: string): Promise<Lesson> {
    const lesson = this.#lesson(lessonId);
    const r = await this.#d.writer.rewrite(lesson, value);
    if (!r.ok) fail("conflict", `the lesson's line could not be changed (${r.reason})`);
    const now = this.#now();
    // The owner's own wording: confirmed.
    const updated = this.#d.store.updateLesson(lessonId, {
      value: r.value,
      statement: r.value.slice(0, 300),
      destination: r.destination,
      confidence: CONFIDENCE.confirmed,
      status: "confirmed",
      confirmedAt: now,
      lastConfirmedAt: now,
    });
    this.#audit("teaching.lesson.edited", { lessonId });
    this.#changed(updated);
    return publicLesson(updated);
  }

  /**
   * Forget (§3.5): the line goes (what it replaced comes back), so do lines dreaming derived from
   * it; the lesson it superseded is live again; a tombstone keeps only its id, kind, fingerprint
   * and date. `purgeSources` also deletes the feedback it came from.
   */
  async forget(lessonId: string, options: { purgeSources?: boolean } = {}): Promise<Lesson> {
    const lesson = this.#lesson(lessonId);
    if (lesson.status === "forgotten") return publicLesson(lesson);
    const store = this.#d.store;
    if (LIVE_STATUSES.includes(lesson.status) || lesson.status === "dormant") {
      const askRule =
        lesson.kind === "boundary" && typeof lesson.scope.recipient === "string"
          ? `recipient:${lesson.scope.recipient}`
          : undefined;
      const stillNeeded =
        askRule !== undefined &&
        store
          .listLessons({ status: LIVE_STATUSES, kind: "boundary", limit: 200 })
          .lessons.some((l) => l.id !== lessonId && l.scope.recipient === lesson.scope.recipient);
      if (LIVE_STATUSES.includes(lesson.status)) {
        await this.#d.writer.remove(lesson, {
          askRule: stillNeeded ? undefined : askRule,
        });
      }
      await this.#d.writer.removeDerived(lessonId);
      if (lesson.supersedes != null && LIVE_STATUSES.includes(lesson.status)) {
        const prev = store.getLesson(lesson.supersedes);
        if (prev?.status === "superseded")
          this.#changed(store.updateLesson(prev.id, { status: "active" }));
      }
    }
    const sources = lesson.sources;
    const now = this.#now();
    const tomb = store.updateLesson(lessonId, {
      status: "forgotten",
      forgottenAt: now,
      statement: "Forgotten lesson",
      previous: null,
      value: "",
      sources: [],
      approvalId: null,
    });
    let purged = 0;
    if (options.purgeSources === true) {
      for (const id of sources) if (store.deleteEvent(id)) purged++;
    } else {
      for (const id of sources) store.linkEvent(id, null);
    }
    this.#audit("teaching.lesson.forgotten", { lessonId, kind: lesson.kind, purged });
    this.#changed(tomb);
    return publicLesson(tomb);
  }

  /** `feedback.delete`: one signal goes; a lesson left with no evidence is forgotten. */
  async deleteEvent(eventId: string): Promise<void> {
    const store = this.#d.store;
    if (store.getEvent(eventId) === undefined) fail("not_found", `feedback ${eventId} not found`);
    const lessons = store.lessonsWithSource(eventId);
    store.deleteEvent(eventId);
    for (const l of lessons) {
      if (l.status === "forgotten") continue;
      const rest = l.sources.filter((s) => s !== eventId);
      if (rest.length === 0) await this.forget(l.id);
      else this.#changed(store.updateLesson(l.id, { sources: rest }));
    }
    this.#audit("teaching.feedback.deleted", { eventId, lessons: lessons.length });
  }

  /** `lastAppliedAt` for lessons a run's prompt included (`lessonsApplied`). */
  markApplied(lessonIds: readonly string[]): void {
    const now = this.#now();
    for (const id of lessonIds) {
      const l = this.#d.store.getLesson(id);
      if (l !== undefined && LIVE_STATUSES.includes(l.status)) {
        this.#d.store.updateLesson(id, { lastAppliedAt: now });
      }
    }
  }
}

function withLineId(d: PlannedDestination, lineId: string): LessonDestination {
  switch (d.type) {
    case "file":
      return { type: "file", path: d.path, section: d.section, lineId };
    case "skill":
      return { type: "skill", skill: d.skill, path: d.path, lineId };
    case "graph":
      return {
        type: "graph",
        entityId: d.entityId,
        ...(d.attribute === undefined ? {} : { attribute: d.attribute }),
        ...(d.rel === undefined ? {} : { rel: d.rel }),
      };
    case "automation":
      return { type: "automation", automationId: d.automationId, field: d.field };
  }
}

/** The card's title (§8 copy): what will change, in Psyche's voice. */
function summaryFor(plan: PlannedLesson): string {
  const d = plan.destination;
  if (plan.kind === "boundary") return `Ask first from now on: ${plan.statement}`.slice(0, 300);
  if (d.type === "file" && d.path === "SOUL.md")
    return `Update how Psyche writes for you: ${plan.statement}`.slice(0, 300);
  if (d.type === "automation") return `Change this automation: ${plan.statement}`.slice(0, 300);
  if (d.type === "skill") return `Teach ${d.skill}: ${plan.statement}`.slice(0, 300);
  return `Remember: ${plan.statement}`.slice(0, 300);
}
