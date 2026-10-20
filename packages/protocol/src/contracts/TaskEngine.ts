import type { JsonObject } from "../common.ts";
import type { ChecklistItem } from "../schemas/blocks.ts";
import type { TaintSource } from "../schemas/permissions.ts";
import type {
  InputRequest,
  Question,
  Task,
  TaskAction,
  TaskCheckpoint,
  TaskOrigin,
  TaskPlan,
  TaskStatus,
  TaskWorkspace,
} from "../schemas/tasks.ts";

/**
 * Task engine contract (architecture §4.5; data model §3; owner S04).
 * Tasks outlive turns; workers claim them with leases. A crashed worker's lease expires and the
 * task becomes claimable again; checkpoints of `replaySafe: false` steps that were `running`
 * at that point become `uncertain` and are reconciled, never replayed.
 */

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "failed", "cancelled"];

export interface TaskCreateInput {
  threadId: string;
  title: string;
  goal: string;
  createdFrom: TaskOrigin;
  plan?: TaskPlan;
  checklist?: ChecklistItem[];
  taint?: boolean;
  /**
   * The creating turn's taint sources (S23 design-08): the Task starts every run tainted with
   * them until the owner re-approves its goal. Persisted with the task, shown on its cards.
   */
  taintSources?: TaintSource[];
  /** Where its commands run; absent means the owner's default (`vm.defaultWorkspace`). */
  workspace?: TaskWorkspace;
}

export interface TaskFilter {
  status?: TaskStatus[];
  threadId?: string;
}

export interface TaskLease {
  taskId: string;
  owner: string;
  /** Epoch ms. */
  until: number;
  /** Changes on every claim; renew/release with a stale token fails with `conflict`. */
  token: string;
}

export interface ClaimOptions {
  leaseMs: number;
  /** Claim this task specifically instead of the next claimable one. */
  taskId?: string;
}

export interface CheckpointInput {
  stepId: string;
  replaySafe: boolean;
  status: TaskCheckpoint["status"];
  payload?: JsonObject | null;
  receiptId?: string | null;
}

export interface TaskActionInput {
  toolCallId?: string | null;
  level1: string;
  level2: TaskAction["level2"];
  level3Ref?: string | null;
}

export interface TaskEngine {
  create(input: TaskCreateInput): Promise<Task>;
  get(taskId: string): Promise<Task | undefined>;
  list(filter?: TaskFilter): Promise<Task[]>;
  /** Rejects (`conflict`) transitions out of a terminal status. */
  updateStatus(
    taskId: string,
    status: TaskStatus,
    patch?: { summary?: string; outcome?: JsonObject },
  ): Promise<Task>;
  /** Claim the next queued task (or one whose lease expired); `undefined` when none. */
  claim(owner: string, options: ClaimOptions): Promise<TaskLease | undefined>;
  renew(lease: TaskLease, leaseMs: number): Promise<TaskLease>;
  release(lease: TaskLease): Promise<void>;
  checkpoint(taskId: string, input: CheckpointInput): Promise<TaskCheckpoint>;
  checkpoints(taskId: string): Promise<TaskCheckpoint[]>;
  addAction(taskId: string, input: TaskActionInput): Promise<TaskAction>;
  actions(taskId: string): Promise<TaskAction[]>;
  /** Parks the task in `awaiting_input`. Input requests never time out. */
  requestInput(taskId: string, questions: Question[]): Promise<InputRequest>;
  /** Answers and re-queues the task. */
  answerInput(
    inputRequestId: string,
    answer: Record<string, string | string[]>,
    options?: { deviceId?: string },
  ): Promise<InputRequest>;
  pause(taskId: string): Promise<Task>;
  resume(taskId: string): Promise<Task>;
  /** Terminal; the lease is dropped and run authority must be revoked by the caller. */
  cancel(taskId: string, reason?: string): Promise<Task>;
  /** `failed` / `cancelled` → `queued`; the next claim runs as `attempt + 1`. */
  retry(taskId: string): Promise<Task>;
}
