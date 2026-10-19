import type {
  ApprovalStatus,
  TaskActionInput as ContractTaskActionInput,
  JsonObject,
  Question,
  RunMode,
  Task,
  TaskAction,
  TaskCreateInput,
} from "@psyche/protocol";

/** Per-task limits enforced by the worker (architecture §4.3 stop conditions). */
export interface TaskBudget {
  /** Tool calls per turn. */
  maxSteps?: number;
  /** Input + output tokens per turn. */
  maxTokens?: number;
  /** Wall-clock milliseconds per turn. */
  maxWallMs?: number;
}

/**
 * What the next turn of a task must be told when it starts: the answers it asked for, how its
 * approval was decided, which steps became uncertain. Consumed (and cleared) at the start of a
 * turn with `takeResume`.
 */
export type ResumeItem =
  | {
      kind: "input_answered";
      inputRequestId: string;
      questions: Question[];
      answer: Record<string, string | string[]>;
    }
  | {
      kind: "approval";
      approvalId: string;
      status: Exclude<ApprovalStatus, "pending">;
      stepId: string | null;
      reason?: string;
    }
  | { kind: "recovered"; previousOwner: string | null; uncertainStepIds: string[] }
  | { kind: "resumed" }
  | { kind: "retry"; fromStepId: string | null }
  | { kind: "reconciled"; stepId: string; status: "done" | "failed"; note?: string };

/** What a parked task waits on. */
export type Awaiting =
  | { kind: "approval"; approvalId: string; stepId: string | null; since: string }
  | { kind: "input"; inputRequestId: string; since: string };

/** `Task` plus the engine-only columns (run mode, budget, what it waits on). */
export interface TaskRecord {
  task: Task;
  runMode: RunMode;
  budget: TaskBudget | null;
  awaiting: Awaiting | null;
  resume: ResumeItem[];
}

export interface CreateTaskInput extends TaskCreateInput {
  /** Defaults to `attended`; automation and heartbeat runs are `unattended`. */
  mode?: RunMode;
  budget?: TaskBudget;
}

/** `TaskActionInput` with an optional raw payload stored through the level-3 store. */
export interface ActionInput extends ContractTaskActionInput {
  /** Raw tool I/O; written through `Level3Store` and replaced by its ref. */
  level3?: JsonObject;
}

/** Where level-3 payloads (raw tool I/O) live: the Library in the Gateway. */
export interface Level3Store {
  put(taskId: string, payload: JsonObject): string;
}

export type TaskEngineEvent =
  | { event: "task.updated"; payload: { task: Task }; stateVersion: number }
  | { event: "task.action"; payload: { action: TaskAction }; stateVersion: number };

export type TaskEventListener = (event: TaskEngineEvent) => void;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
