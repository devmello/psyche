import {
  type CheckpointInput,
  type ClaimOptions,
  type Clock,
  type InputRequest,
  type JsonObject,
  type Question,
  type Task,
  type TaskAction,
  type TaskActionInput,
  type TaskCheckpoint,
  type TaskCreateInput,
  type TaskEngine,
  type TaskFilter,
  type TaskLease,
  type TaskStatus,
  TERMINAL_TASK_STATUSES,
} from "@psyche/protocol";
import { FakeClock, toIso } from "../clock.ts";
import { createIdGenerator, type IdGenerator } from "../ids.ts";
import { fail } from "./errors.ts";

export interface FakeTaskEngineOptions {
  clock?: Clock;
  ids?: IdGenerator;
}

const isTerminal = (s: TaskStatus) => TERMINAL_TASK_STATUSES.includes(s);

/** In-memory task engine with leases on an injectable clock (architecture §4.5). */
export class FakeTaskEngine implements TaskEngine {
  readonly clock: Clock;
  #ids: IdGenerator;
  #tasks = new Map<string, Task>();
  #leaseTokens = new Map<string, string>();
  #checkpoints = new Map<string, TaskCheckpoint[]>();
  #actions = new Map<string, TaskAction[]>();
  #inputs = new Map<string, InputRequest>();

  constructor(options: FakeTaskEngineOptions = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.#ids = options.ids ?? createIdGenerator();
  }

  #now(): string {
    return toIso(this.clock.now());
  }

  #task(taskId: string): Task {
    const t = this.#tasks.get(taskId);
    if (t === undefined) return fail("not_found", `task ${taskId} not found`);
    return t;
  }

  #set(task: Task, status: TaskStatus): void {
    if (isTerminal(task.status) && status !== task.status) {
      fail("conflict", `task ${task.id} is ${task.status}`);
    }
    task.status = status;
    task.updatedAt = this.#now();
    if (isTerminal(status)) {
      task.completedAt = task.updatedAt;
      task.leaseOwner = null;
      task.leaseUntil = null;
      this.#leaseTokens.delete(task.id);
    }
  }

  async create(input: TaskCreateInput): Promise<Task> {
    const now = this.#now();
    const task: Task = {
      id: this.#ids.next("task"),
      threadId: input.threadId,
      title: input.title,
      goal: input.goal,
      status: "queued",
      createdFrom: input.createdFrom,
      plan: input.plan === undefined ? null : structuredClone(input.plan),
      checklist: structuredClone(input.checklist ?? []),
      currentStepId: null,
      attempt: 0,
      leaseOwner: null,
      leaseUntil: null,
      browserSessionId: null,
      sandboxId: null,
      summary: null,
      outcome: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    if (input.taint !== undefined) task.taint = input.taint;
    if (input.taintSources !== undefined) task.taintSources = structuredClone(input.taintSources);
    if (input.workspace !== undefined) task.workspace = input.workspace;
    this.#tasks.set(task.id, task);
    return structuredClone(task);
  }

  async get(taskId: string): Promise<Task | undefined> {
    const t = this.#tasks.get(taskId);
    return t === undefined ? undefined : structuredClone(t);
  }

  async list(filter: TaskFilter = {}): Promise<Task[]> {
    return [...this.#tasks.values()]
      .filter((t) => filter.status === undefined || filter.status.includes(t.status))
      .filter((t) => filter.threadId === undefined || t.threadId === filter.threadId)
      .map((t) => structuredClone(t));
  }

  async updateStatus(
    taskId: string,
    status: TaskStatus,
    patch: { summary?: string; outcome?: JsonObject } = {},
  ): Promise<Task> {
    const task = this.#task(taskId);
    this.#set(task, status);
    if (patch.summary !== undefined) task.summary = patch.summary;
    if (patch.outcome !== undefined) task.outcome = structuredClone(patch.outcome);
    return structuredClone(task);
  }

  #claimable(task: Task, now: number): boolean {
    if (task.status === "queued") return true;
    return (
      task.status === "running" && task.leaseUntil != null && Date.parse(task.leaseUntil) <= now
    );
  }

  async claim(owner: string, options: ClaimOptions): Promise<TaskLease | undefined> {
    const now = this.clock.now();
    const candidates =
      options.taskId === undefined
        ? [...this.#tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        : [this.#task(options.taskId)];
    const task = candidates.find((t) => this.#claimable(t, now));
    if (task === undefined) return undefined;
    if (task.status === "running") {
      // Expired lease: in-flight unsafe steps become uncertain, never replayed.
      for (const cp of this.#checkpoints.get(task.id) ?? []) {
        if (cp.status === "running" && !cp.replaySafe) cp.status = "uncertain";
      }
    }
    task.status = "running";
    task.attempt += 1;
    task.leaseOwner = owner;
    task.leaseUntil = toIso(now + options.leaseMs);
    task.updatedAt = toIso(now);
    const token = this.#ids.next("lease");
    this.#leaseTokens.set(task.id, token);
    return { taskId: task.id, owner, until: now + options.leaseMs, token };
  }

  #checkLease(lease: TaskLease): Task {
    const task = this.#task(lease.taskId);
    if (this.#leaseTokens.get(task.id) !== lease.token) {
      return fail("conflict", "lease lost");
    }
    if (task.leaseUntil != null && Date.parse(task.leaseUntil) <= this.clock.now()) {
      return fail("conflict", "lease expired");
    }
    return task;
  }

  async renew(lease: TaskLease, leaseMs: number): Promise<TaskLease> {
    const task = this.#checkLease(lease);
    const until = this.clock.now() + leaseMs;
    task.leaseUntil = toIso(until);
    return { ...lease, until };
  }

  async release(lease: TaskLease): Promise<void> {
    const task = this.#tasks.get(lease.taskId);
    if (task === undefined || this.#leaseTokens.get(task.id) !== lease.token) return;
    this.#leaseTokens.delete(task.id);
    task.leaseOwner = null;
    task.leaseUntil = null;
    if (task.status === "running") task.status = "queued";
    task.updatedAt = this.#now();
  }

  async checkpoint(taskId: string, input: CheckpointInput): Promise<TaskCheckpoint> {
    this.#task(taskId);
    const list = this.#checkpoints.get(taskId) ?? [];
    const existing = list.find((c) => c.stepId === input.stepId);
    if (existing !== undefined) {
      existing.status = input.status;
      existing.replaySafe = input.replaySafe;
      if (input.payload !== undefined) existing.payload = structuredClone(input.payload);
      if (input.receiptId !== undefined) existing.receiptId = input.receiptId;
      return structuredClone(existing);
    }
    const cp: TaskCheckpoint = {
      id: this.#ids.next("ckpt"),
      taskId,
      stepId: input.stepId,
      idx: list.length,
      replaySafe: input.replaySafe,
      status: input.status,
      payload: input.payload == null ? null : structuredClone(input.payload),
      receiptId: input.receiptId ?? null,
      createdAt: this.#now(),
    };
    list.push(cp);
    this.#checkpoints.set(taskId, list);
    const task = this.#task(taskId);
    task.currentStepId = input.stepId;
    return structuredClone(cp);
  }

  async checkpoints(taskId: string): Promise<TaskCheckpoint[]> {
    return structuredClone(this.#checkpoints.get(taskId) ?? []);
  }

  async addAction(taskId: string, input: TaskActionInput): Promise<TaskAction> {
    this.#task(taskId);
    const list = this.#actions.get(taskId) ?? [];
    const action: TaskAction = {
      id: this.#ids.next("act"),
      taskId,
      idx: list.length,
      toolCallId: input.toolCallId ?? null,
      level1: input.level1,
      level2: structuredClone(input.level2),
      level3Ref: input.level3Ref ?? null,
      createdAt: this.#now(),
    };
    list.push(action);
    this.#actions.set(taskId, list);
    return structuredClone(action);
  }

  async actions(taskId: string): Promise<TaskAction[]> {
    return structuredClone(this.#actions.get(taskId) ?? []);
  }

  async requestInput(taskId: string, questions: Question[]): Promise<InputRequest> {
    const task = this.#task(taskId);
    if (questions.length < 1 || questions.length > 4) {
      return fail("invalid_params", "1–4 questions");
    }
    this.#set(task, "awaiting_input");
    const req: InputRequest = {
      id: this.#ids.next("inp"),
      taskId,
      threadId: task.threadId,
      questions: structuredClone(questions),
      status: "open",
      answer: null,
      createdAt: this.#now(),
      answeredAt: null,
      answeredByDeviceId: null,
    };
    this.#inputs.set(req.id, req);
    return structuredClone(req);
  }

  async answerInput(
    inputRequestId: string,
    answer: Record<string, string | string[]>,
    options: { deviceId?: string } = {},
  ): Promise<InputRequest> {
    const req = this.#inputs.get(inputRequestId);
    if (req === undefined) return fail("not_found", "input request not found");
    if (req.status !== "open") return fail("conflict", `input request is ${req.status}`);
    req.status = "answered";
    req.answer = structuredClone(answer);
    req.answeredAt = this.#now();
    req.answeredByDeviceId = options.deviceId ?? null;
    if (req.taskId != null) {
      const task = this.#task(req.taskId);
      if (task.status === "awaiting_input") {
        this.#set(task, "queued");
        task.leaseOwner = null;
        task.leaseUntil = null;
      }
    }
    return structuredClone(req);
  }

  async pause(taskId: string): Promise<Task> {
    const task = this.#task(taskId);
    this.#set(task, "paused");
    task.leaseOwner = null;
    task.leaseUntil = null;
    this.#leaseTokens.delete(taskId);
    return structuredClone(task);
  }

  async resume(taskId: string): Promise<Task> {
    const task = this.#task(taskId);
    if (task.status !== "paused") return fail("conflict", `task is ${task.status}, not paused`);
    this.#set(task, "queued");
    return structuredClone(task);
  }

  async cancel(taskId: string, reason?: string): Promise<Task> {
    const task = this.#task(taskId);
    this.#set(task, "cancelled");
    if (reason !== undefined) task.summary = reason;
    for (const req of this.#inputs.values()) {
      if (req.taskId === taskId && req.status === "open") req.status = "cancelled";
    }
    return structuredClone(task);
  }

  async retry(taskId: string): Promise<Task> {
    const task = this.#task(taskId);
    if (task.status !== "failed" && task.status !== "cancelled") {
      return fail("conflict", `only failed or cancelled tasks can be retried (is ${task.status})`);
    }
    task.status = "queued";
    task.completedAt = null;
    task.updatedAt = this.#now();
    return structuredClone(task);
  }
}
