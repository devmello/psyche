import {
  type PermissionMode,
  type ProvenanceOut,
  PsycheError,
  type Requester,
  type RunMode,
  type SideEffect,
  type TaintSource,
  type TargetKind,
  type ToolCallAuthority,
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
  /** Where the taint came from (security §3.6), oldest first; absent or empty when not tainted. */
  taintSources?: readonly TaintSource[];
  permissionMode: PermissionMode;
  mode: RunMode;
  /** Approval that authorized this dispatch, when the broker asked (= `authority.approvalId`). */
  approvalId?: string;
  /**
   * What authorized this dispatch (security §3.3): the broker's decision as the loop verified
   * it right before the call. Executors with their own enforcement confirm, without consuming,
   * that the approval or standing grant it names is live and covers these exact arguments.
   */
  authority?: ToolCallAuthority;
  /** Who asked for the turn (security §9); absent means the owner. */
  requester?: Requester;
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

type JsonSchema = Record<string, unknown>;

const isObjectSchema = (
  v: unknown,
): v is JsonSchema & { properties?: Record<string, JsonSchema> } =>
  typeof v === "object" && v !== null && (v as JsonSchema).type === "object";

/** The property every alternative pins with `const` (`op`, `command`), if there is one. */
function discriminatorOf(alts: readonly JsonSchema[]): string | undefined {
  const first = alts[0]?.properties as Record<string, JsonSchema> | undefined;
  for (const key of Object.keys(first ?? {})) {
    if (
      alts.every(
        (a) => (a.properties as Record<string, JsonSchema> | undefined)?.[key]?.const !== undefined,
      )
    )
      return key;
  }
  return undefined;
}

/**
 * Providers take a tool's input schema only as one top-level `type: "object"` (Anthropic refuses
 * the whole request otherwise, OpenAI's function `parameters` too; #414). A union of object
 * variants (`code.git`'s operations, `memory`'s commands) is advertised as one object: the
 * discriminator becomes an enum whose description names each value's required fields, every
 * other field is optional, and a field the variants type differently keeps an `anyOf` inside the
 * property. Validation still checks the exact variant (`firstSchemaError` on the TypeBox union).
 */
export function toObjectSchema(schema: JsonSchema): JsonSchema {
  if (schema.type === "object") return schema;
  const alts = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (!Array.isArray(alts) || alts.length === 0 || !alts.every(isObjectSchema)) {
    // Not a union of objects: wrap nothing, but never send a schema without the object type.
    return { ...schema, type: "object" };
  }
  const key = discriminatorOf(alts);
  const properties: Record<string, JsonSchema> = {};
  const seen = new Map<string, JsonSchema[]>();
  for (const alt of alts) {
    for (const [name, prop] of Object.entries(
      (alt.properties ?? {}) as Record<string, JsonSchema>,
    )) {
      if (name === key) continue;
      const list = seen.get(name) ?? [];
      if (!list.some((p) => JSON.stringify(p) === JSON.stringify(prop))) list.push(prop);
      seen.set(name, list);
    }
  }
  // Required only where every variant requires it.
  const required = new Set((alts[0]?.required as string[] | undefined) ?? []);
  for (const alt of alts.slice(1)) {
    const r = new Set((alt.required as string[] | undefined) ?? []);
    for (const k of required) if (!r.has(k)) required.delete(k);
  }
  if (key !== undefined) {
    const values = alts.map((a) => (a.properties as Record<string, JsonSchema>)[key]?.const);
    const needs = alts.map((a) => {
      const extra = ((a.required as string[] | undefined) ?? []).filter(
        (k) => k !== key && !required.has(k),
      );
      const value = String((a.properties as Record<string, JsonSchema>)[key]?.const);
      return extra.length === 0 ? value : `${value} (requires ${extra.join(", ")})`;
    });
    properties[key] = {
      type: "string",
      enum: values,
      description: `One of: ${needs.join("; ")}. Other fields apply only where they fit.`,
    };
    required.add(key);
  }
  for (const [name, list] of seen) {
    properties[name] = list.length === 1 ? (list[0] as JsonSchema) : { anyOf: list };
  }
  const { anyOf: _a, oneOf: _o, ...rest } = schema;
  return {
    ...rest,
    type: "object",
    properties,
    required: [...required],
  };
}

/** Strip TypeBox's symbol keys so the schema is plain JSON, with the object type providers need. */
export function toJsonSchema(schema: TSchema): Record<string, unknown> {
  return toObjectSchema(JSON.parse(JSON.stringify(schema)) as JsonSchema);
}

export function firstSchemaError(schema: TSchema, value: unknown): string | undefined {
  if (Value.Check(schema, value)) return undefined;
  // A union of variants keyed by a constant field: report the chosen variant's own error.
  const alts = (schema as { anyOf?: TSchema[] }).anyOf;
  if (Array.isArray(alts) && typeof value === "object" && value !== null) {
    const key = discriminatorOf(alts as unknown as JsonSchema[]);
    if (key !== undefined) {
      const chosen = (value as Record<string, unknown>)[key];
      const variant = alts.find(
        (a) =>
          (a as unknown as { properties?: Record<string, { const?: unknown }> }).properties?.[key]
            ?.const === chosen,
      );
      if (variant === undefined) {
        const allowed = alts.map(
          (a) =>
            (a as unknown as { properties: Record<string, { const?: unknown }> }).properties[key]
              ?.const,
        );
        return `/${key}: must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`;
      }
      return firstSchemaError(variant, value);
    }
  }
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
export const UNATTENDED_WITHHELD = new Set([
  "ask_user",
  "exit_plan_mode",
  // Unattended runs start specialists only through an automation's own field (specialists §4.9).
  "specialist.spawn",
]);
/**
 * Tools withheld from subagents (C6; architecture §4.3): no `ask_user`, messaging or approval
 * authority, no work that outlives the parent turn, and no nesting.
 */
export const SUBAGENT_WITHHELD = new Set([
  "ask_user",
  "exit_plan_mode",
  "wrap_up",
  "subagent.spawn",
  "task.start",
  "schedule",
  "notify",
  "specialist.spawn",
  "specialist.status",
  "specialist.report",
]);
/** Tools offered only in plan mode. */
export const PLAN_ONLY = new Set(["exit_plan_mode"]);
/**
 * `none` tools still withheld in plan mode: a task would run outside the plan's read-only mode
 * (`TaskCreateInput` carries no permission mode).
 */
export const PLAN_WITHHELD = new Set(["task.start", "specialist.spawn"]);
/** Tools a background specialist never gets, whatever its allowlist says (specialists §4.3). */
export const SPECIALIST_WITHHELD = new Set([
  "specialist.spawn",
  "specialist.status",
  "schedule",
  "wrap_up",
  "task.start",
]);
/** Tools only a specialist run sees. */
export const SPECIALIST_ONLY = new Set(["specialist.report"]);

export interface ActiveToolsInput {
  permissionMode: PermissionMode;
  runMode: RunMode;
  /** A subagent run (C6): see `SUBAGENT_WITHHELD`; tools that reach a recipient are hidden too. */
  subagent?: boolean;
  /** A background specialist's run (specialists §4.3): see `SPECIALIST_WITHHELD`. */
  specialist?: boolean;
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
  if (input.subagent === true && (SUBAGENT_WITHHELD.has(name) || spec.targetKind === "recipient")) {
    return "not available to subagents";
  }
  if (SPECIALIST_ONLY.has(name) && input.specialist !== true) return "only for specialists";
  if (input.specialist === true && SPECIALIST_WITHHELD.has(name)) {
    return "not available to specialists";
  }
  if (input.runMode === "unattended" && UNATTENDED_WITHHELD.has(name)) {
    return "not available in unattended runs";
  }
  if (PLAN_ONLY.has(name) && input.permissionMode !== "plan") return "only available in plan mode";
  if (input.permissionMode === "plan" && (spec.sideEffect !== "none" || PLAN_WITHHELD.has(name))) {
    return "plan mode is read-only";
  }
  return undefined;
}
