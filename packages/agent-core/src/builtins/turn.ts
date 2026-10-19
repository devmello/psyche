import {
  type Block,
  type ChecklistItem,
  type InputRequest,
  PsycheError,
  type Question,
  WrapUpAction,
} from "@psyche/protocol";
import { Type } from "@sinclair/typebox";
import { applyPlanUpdate, UpdatePlanInput } from "../checklist.ts";
import { AskUserInput, normalizeQuestions, type QuestionAnswer } from "../questions.ts";
import { type AgentToolRegistration, defineTool, type ToolRunContext } from "../registry.ts";
import type { HarnessTurnApi } from "./harness.ts";

/** What the loop lends its turn tools: blocks, the checklist, questions and plan approval. */
export interface TurnApi {
  emitBlock(block: Block): void;
  checklist(): ChecklistItem[];
  setChecklist(items: ChecklistItem[]): void;
  /** Attended: resolves with the answer. Background (task) run: parks the task and the turn. */
  ask(questions: Question[]): Promise<{ answer: QuestionAnswer } | { parked: InputRequest }>;
  /** C10: gate one action of an embedded coding harness through the broker. */
  gateHarnessAction?: HarnessTurnApi["gateHarnessAction"];
  harnessActionDone?: HarnessTurnApi["harnessActionDone"];
  /** Runs a subagent to completion (C6); its result comes back as this tool's result. */
  spawnSubagent(input: SpawnSubagentInput): Promise<SubagentResult>;
  /** Emits the plan block and waits for the `plan_exit` approval. */
  exitPlan(plan: { title: string; plan: string }): Promise<{
    planId: string;
    approved: boolean;
    reason?: string;
  }>;
}

export interface TurnToolContext extends ToolRunContext {
  turn: TurnApi;
}

function turnOf(ctx: ToolRunContext): TurnApi {
  const turn = (ctx as Partial<TurnToolContext>).turn;
  if (turn === undefined) throw new PsycheError("internal", "turn tools run inside the agent loop");
  return turn;
}

const ok = (output: unknown) => ({ output, provenance: "trusted" as const });

export const askUserTool = defineTool({
  name: "ask_user",
  description:
    'Ask the owner 1–4 multiple-choice questions when a decision is theirs. Each question has a header of at most 12 characters, 2–4 options (put the one you recommend first and end its label with "(Recommended)"), and multiSelect. The owner can always type their own answer instead.',
  input: AskUserInput,
  sideEffect: "none",
  run: async (params, ctx) => {
    const questions = normalizeQuestions(params);
    const result = await turnOf(ctx).ask(questions);
    if ("parked" in result) {
      return ok({
        status: "awaiting_input",
        inputRequestId: result.parked.id,
        note: "The task is parked until the owner answers; it resumes with the answer.",
      });
    }
    return ok({ answers: result.answer });
  },
});

export const updatePlanTool = defineTool({
  name: "update_plan",
  description:
    "Keep the checklist pinned under your latest message. Send the whole list as items (text + status pending | in_progress | completed), or advance: true to complete the current item and start the next, or done: [n] / start: n (1-based) out of order. Exactly one item is in_progress while work remains.",
  input: UpdatePlanInput,
  sideEffect: "none",
  run: async (params, ctx) => {
    const turn = turnOf(ctx);
    const items = applyPlanUpdate(turn.checklist(), params);
    turn.setChecklist(items);
    turn.emitBlock({ type: "checklist", items });
    return ok({ items });
  },
});

export const WrapUpInput = Type.Object(
  {
    recap: Type.String({
      minLength: 1,
      maxLength: 300,
      description: "What is now true, and what is not done",
    }),
    ask: Type.Optional(
      Type.String({ minLength: 1, maxLength: 100, description: "One decision for the owner" }),
    ),
    actions: Type.Optional(Type.Array(WrapUpAction, { minItems: 1, maxItems: 2 })),
    blocked: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const wrapUpTool = defineTool({
  name: "wrap_up",
  description:
    "End a turn that did real work with a recap (≤300 chars) and, when the next move is the owner's, one question (≤100 chars) with 1–2 reply buttons, your recommendation first.",
  input: WrapUpInput,
  sideEffect: "none",
  run: async (params, ctx) => {
    if (params.actions !== undefined && params.ask === undefined) {
      throw new PsycheError("invalid_params", "actions answer a question: add ask");
    }
    const block: Block = {
      type: "wrap_up",
      recap: params.recap,
      ...(params.ask === undefined ? {} : { ask: params.ask }),
      ...(params.actions === undefined ? {} : { actions: params.actions }),
    };
    turnOf(ctx).emitBlock(block);
    return ok({ shown: true });
  },
});

export const ExitPlanInput = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 120 }),
    plan: Type.String({ minLength: 1, maxLength: 20_000, description: "The plan in Markdown" }),
  },
  { additionalProperties: false },
);

export const exitPlanModeTool = defineTool({
  name: "exit_plan_mode",
  description:
    "Plan mode only: present the plan for the owner's approval. If approved, the thread leaves plan mode and you may carry the plan out; if not, keep planning.",
  input: ExitPlanInput,
  sideEffect: "none",
  run: async (params, ctx) => {
    const result = await turnOf(ctx).exitPlan(params);
    if (result.approved) {
      return ok({
        planId: result.planId,
        approved: true,
        note: "Plan approved. Track progress with update_plan as you carry it out.",
      });
    }
    return ok({
      planId: result.planId,
      approved: false,
      note: `Plan not approved${result.reason === undefined ? "" : ` (${result.reason})`}. Keep planning.`,
    });
  },
});

/** Tools that need the turn (questions, checklist, wrap-up, plan exit). */
export function turnTools(): AgentToolRegistration[] {
  return [askUserTool, updatePlanTool, wrapUpTool, exitPlanModeTool, subagentSpawnTool];
}

export interface SpawnSubagentInput {
  /** `fork` inherits this thread's transcript; `fresh` sees only the brief. */
  context: "fork" | "fresh";
  title: string;
  brief: string;
}

export interface SubagentResult {
  subagentId: string;
  threadId: string;
  outcome: "final" | "failed" | "cancelled";
  result: string;
  /** The subagent read untrusted content: its result is untrusted too. */
  tainted: boolean;
  steps: number;
  error?: string;
}

export const SpawnSubagentInputSchema = Type.Object(
  {
    context: Type.Union([Type.Literal("fork"), Type.Literal("fresh")], {
      description: "fork: the subagent sees this conversation; fresh: only the brief",
    }),
    title: Type.String({ minLength: 1, maxLength: 80 }),
    brief: Type.String({
      minLength: 1,
      maxLength: 8_000,
      description: "Everything the subagent needs: goal, scope, and what done looks like",
    }),
  },
  { additionalProperties: false },
);

export const subagentSpawnTool = defineTool({
  name: "subagent.spawn",
  description:
    "Run a subagent on a self-contained piece of work (research, reading, comparison) and get its result back. Several can run at once. Subagents use the same tools and permissions minus questions, messaging and approvals: anything that needs the owner's approval comes back to you.",
  input: SpawnSubagentInputSchema,
  sideEffect: "none",
  describeCall: (p) => ({ summary: `Subagent: ${p.title}` }),
  run: async (params, ctx) => {
    const r = await turnOf(ctx).spawnSubagent(params);
    return {
      output: {
        subagentId: r.subagentId,
        outcome: r.outcome,
        result: r.result,
        steps: r.steps,
        ...(r.error === undefined ? {} : { error: r.error }),
      },
      ...(r.outcome === "final" ? {} : { isError: true }),
      provenance: r.tainted ? "untrusted" : "trusted",
    };
  },
});
