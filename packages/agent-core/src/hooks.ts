import type {
  AgentHookName,
  BeforeToolCallResult,
  ContextSection,
  ModelMessage,
  ModelRef,
  PermissionMode,
  RunMode,
  RunOutcome,
  ToolCall,
  ToolResult,
  ToolSpec,
  Unsubscribe,
  Usage,
} from "@psyche/protocol";

type MaybePromise<T> = T | Promise<T>;

export interface RunRef {
  threadId: string;
  runId: string;
  taskId?: string;
}

export interface ModelResolveContext extends RunRef {
  model: ModelRef;
}

export interface PromptBuildContext extends RunRef {
  permissionMode: PermissionMode;
  mode: RunMode;
  sections: readonly ContextSection[];
  tools: readonly ToolSpec[];
}

export interface PromptBuildResult {
  /** Extra sections appended after the built-in ones (kind is forced to `hook`). */
  appendSections?: Omit<ContextSection, "kind">[];
  /** Narrow the tool set for this model call; names not listed are hidden. Never widens. */
  toolsAllow?: string[];
}

export interface ToolCallHookContext extends RunRef {
  toolCallId: string;
  tool: string;
  params: unknown;
  spec: ToolSpec;
  taint: boolean;
  permissionMode: PermissionMode;
  mode: RunMode;
}

export interface AfterToolCallContext extends ToolCallHookContext {
  result: ToolResult;
}

export interface CompactionContext extends RunRef {
  /** The messages about to be summarized (read-only view). */
  messages: readonly ModelMessage[];
  estimatedTokens: number;
  contextWindow: number;
}

export interface AgentEndContext extends RunRef {
  outcome: RunOutcome;
  usage: Usage;
  steps: number;
  error?: string;
}

/**
 * Hook surface (architecture §13). Handlers run in registration order. `before_tool_call` may
 * block or suspend, never allow; the first non-`continue` answer wins and a throwing handler
 * blocks the call (fail closed). `after_tool_call` may rewrite the result (secret masking) but
 * can never lower its provenance.
 */
export interface HookHandlers {
  before_model_resolve: (ctx: ModelResolveContext) => MaybePromise<{ model?: ModelRef } | undefined>;
  before_prompt_build: (ctx: PromptBuildContext) => MaybePromise<PromptBuildResult | undefined>;
  before_tool_call: (ctx: ToolCallHookContext) => MaybePromise<BeforeToolCallResult | undefined>;
  after_tool_call: (ctx: AfterToolCallContext) => MaybePromise<{ result?: ToolResult } | undefined>;
  /** The `tool_calls` row (data model §2) and the result, for the Gateway to persist. */
  tool_result_persist: (ctx: { record: ToolCall; result: ToolResult }) => MaybePromise<void>;
  before_compaction: (ctx: CompactionContext) => MaybePromise<void>;
  agent_end: (ctx: AgentEndContext) => MaybePromise<void>;
}

export type HookMap = { [K in AgentHookName]?: HookHandlers[K] | HookHandlers[K][] };

export class HookRegistry {
  #handlers: { [K in AgentHookName]: HookHandlers[K][] } = {
    before_model_resolve: [],
    before_prompt_build: [],
    before_tool_call: [],
    after_tool_call: [],
    tool_result_persist: [],
    before_compaction: [],
    agent_end: [],
  };

  constructor(initial: HookMap = {}) {
    for (const name of Object.keys(initial) as AgentHookName[]) {
      const value = initial[name];
      if (value === undefined) continue;
      for (const fn of Array.isArray(value) ? value : [value]) {
        this.on(name, fn as HookHandlers[typeof name]);
      }
    }
  }

  on<K extends AgentHookName>(name: K, handler: HookHandlers[K]): Unsubscribe {
    const list = this.#handlers[name] as HookHandlers[K][];
    list.push(handler);
    return () => {
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    };
  }

  handlers<K extends AgentHookName>(name: K): readonly HookHandlers[K][] {
    return [...(this.#handlers[name] as HookHandlers[K][])];
  }
}
