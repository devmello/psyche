import {
  type PermissionMode,
  type ProvenanceOut,
  PsycheError,
  type RunMode,
  type SideEffect,
  type TargetKind,
  type ToolCallDescription,
  type ToolExecutor,
  type ToolRegistration,
  type ToolRegistry,
  type ToolResult,
  type ToolSpec,
  type ToolUpdate,
  type Unsubscribe,
} from "@psyche/protocol";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** What an in-process tool sees of the run that called it. */
export interface ToolRunContext {
  callId: string;
  threadId: string;
  runId: string;
  taskId?: string;
  /** The turn has read untrusted content: writes must carry `untrusted` provenance. */
  taint: boolean;
  permissionMode: PermissionMode;
  mode: RunMode;
  /** Approval that authorized this dispatch, when the broker asked. */
  approvalId?: string;
  signal: AbortSignal;
  onUpdate: (update: ToolUpdate) => void;
}

/**
 * A registration as the agent loop stores it: the protocol `ToolRegistration` plus optional
 * param validation and an in-process executor that receives the run context. Executors from
 * other packages (browser, sandbox, MCP) register plain `ToolRegistration`s.
 */
export interface AgentToolRegistration extends ToolRegistration {
  /** Returns an error message for invalid params; the call never reaches the broker. */
  validate?: (params: unknown) => string | undefined;
  /** Preferred over `execute` when present. */
  run?: (params: unknown, ctx: ToolRunContext) => Promise<ToolResult>;
}

export interface DefineToolInput<T extends TSchema> {
  name: string;
  description: string;
  /** TypeBox schema; it is JSON Schema, so it becomes `ToolSpec.inputSchema` as is. */
  input: T;
  sideEffect: SideEffect;
  targetKind?: TargetKind;
  provenanceOut?: ProvenanceOut;
  describeCall?: (params: Static<T>) => ToolCallDescription;
  run: (params: Static<T>, ctx: ToolRunContext) => Promise<ToolResult>;
}

/** Strip TypeBox's symbol keys so the schema is plain JSON. */
export function toJsonSchema(schema: TSchema): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

export function firstSchemaError(schema: TSchema, value: unknown): string | undefined {
  if (Value.Check(schema, value)) return undefined;
  const first = Value.Errors(schema, value).First();
  if (first === undefined) return "invalid params";
  const at = first.path === "" ? "params" : first.path;
  return `${at}: ${first.message}`;
}

/** Declare an in-process tool with a typed, validated input. */
export function defineTool<T extends TSchema>(def: DefineToolInput<T>): AgentToolRegistration {
  const spec: ToolSpec = {
    name: def.name,
    description: def.description,
    inputSchema: toJsonSchema(def.input),
    sideEffect: def.sideEffect,
    provenanceOut: def.provenanceOut ?? "trusted",
    ...(def.targetKind === undefined ? {} : { targetKind: def.targetKind }),
  };
  const describe = def.describeCall;
  const registration: AgentToolRegistration = {
    spec,
    validate: (params) => firstSchemaError(def.input, params),
    run: (params, ctx) => def.run(params as Static<T>, ctx),
    execute: () =>
      Promise.reject(
        new PsycheError("internal", `${def.name} runs in-process through the agent loop`),
      ),
  };
  if (describe !== undefined) {
    registration.describeCall = (params) => describe(params as Static<T>);
  }
  return registration;
}

const MCP_PART = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** `mcp__<server>__<tool>` (architecture §4.3): the key users see in allow / ask / deny rules. */
export function mcpToolName(server: string, tool: string): string {
  if (!MCP_PART.test(server) || server.includes("__")) {
    throw new PsycheError("invalid_params", `invalid MCP server id: ${server}`);
  }
  if (!MCP_PART.test(tool)) throw new PsycheError("invalid_params", `invalid MCP tool: ${tool}`);
  return `mcp__${server}__${tool}`;
}

export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice(5);
  const sep = rest.indexOf("__");
  if (sep <= 0 || sep + 2 >= rest.length) return undefined;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

/** Tools never offered to unattended runs (C4, C8): nobody is there to answer. */
export const UNATTENDED_WITHHELD = new Set(["ask_user", "exit_plan_mode"]);
/** Tools offered only in plan mode. */
export const PLAN_ONLY = new Set(["exit_plan_mode"]);

export interface ActiveToolsInput {
  permissionMode: PermissionMode;
  runMode: RunMode;
  /** Per-tool user toggles (C3): `false` hides the tool. */
  toggles?: Record<string, boolean>;
  /** Narrowing from `before_prompt_build` hooks; never widens. */
  allow?: ReadonlySet<string>;
}

export interface ActiveToolsResult {
  tools: AgentToolRegistration[];
  /** Why each registered tool is not offered, for the prompt viewer and errors. */
  hidden: Map<string, string>;
}

/**
 * The single source of tool metadata (architecture §4.3). Registration order is kept so the
 * prompt and its golden file are stable.
 */
export class AgentToolRegistry implements ToolRegistry {
  #tools = new Map<string, AgentToolRegistration>();

  list(): ToolSpec[] {
    return [...this.#tools.values()].map((t) => structuredClone(t.spec));
  }

  get(name: string): AgentToolRegistration | undefined {
    return this.#tools.get(name);
  }

  register(registration: ToolRegistration | AgentToolRegistration): Unsubscribe {
    const name = registration.spec.name;
    if (!TOOL_NAME.test(name)) throw new PsycheError("invalid_params", `invalid tool name ${name}`);
    if (this.#tools.has(name)) throw new PsycheError("conflict", `tool ${name} already registered`);
    this.#tools.set(name, registration);
    return () => {
      if (this.#tools.get(name) === registration) this.#tools.delete(name);
    };
  }

  /** Register a plain executor (the shape other packages use). */
  registerExecutor(spec: ToolSpec, execute: ToolExecutor): Unsubscribe {
    return this.register({ spec, execute });
  }

  /** The tool set for one model call (C3 toggles, plan mode, unattended contract). */
  active(input: ActiveToolsInput): ActiveToolsResult {
    const tools: AgentToolRegistration[] = [];
    const hidden = new Map<string, string>();
    for (const [name, tool] of this.#tools) {
      const reason = hiddenReason(name, tool.spec, input);
      if (reason === undefined) tools.push(tool);
      else hidden.set(name, reason);
    }
    return { tools, hidden };
  }
}

function hiddenReason(name: string, spec: ToolSpec, input: ActiveToolsInput): string | undefined {
  if (input.toggles?.[name] === false) return "turned off in settings";
  if (input.allow !== undefined && !input.allow.has(name)) return "removed by a hook";
  if (input.runMode === "unattended" && UNATTENDED_WITHHELD.has(name)) {
    return "not available in unattended runs";
  }
  if (PLAN_ONLY.has(name) && input.permissionMode !== "plan") return "only available in plan mode";
  if (input.permissionMode === "plan" && spec.sideEffect !== "none") {
    return "plan mode is read-only";
  }
  return undefined;
}
