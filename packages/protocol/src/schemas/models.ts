import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTime, ModelRef, StringEnum } from "../common.ts";

/**
 * Model providers as Settings → Model & providers shows them (feature B1, B4; architecture
 * §4.4). Keys never appear here: a provider says only whether it has a credential profile.
 */

/**
 * Where a capability fact came from: the server's own model listing (`listing`), the vendored
 * price/capability table (`catalog`), the owner's provider config (`config`), or a guess from
 * the model id (`heuristic`, e.g. `-vl` → vision).
 */
export const ModelFactSource = StringEnum(["listing", "catalog", "config", "heuristic"], {
  $id: "ModelFactSource",
});
export type ModelFactSource = Static<typeof ModelFactSource>;

/** Capability guesses for one model. An absent flag is unknown, not false. */
export const ModelCapabilityGuess = Type.Object(
  {
    toolCalling: Type.Optional(Type.Boolean()),
    vision: Type.Optional(Type.Boolean()),
    reasoning: Type.Optional(Type.Boolean()),
    embeddings: Type.Optional(Type.Boolean()),
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    source: ModelFactSource,
  },
  { $id: "ModelCapabilityGuess" },
);
export type ModelCapabilityGuess = Static<typeof ModelCapabilityGuess>;

/** One model an endpoint listed. */
export const ProbedModel = Type.Object(
  {
    /** `<provider id>/<model id>`. */
    ref: ModelRef,
    /** The model id as the server names it. */
    id: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String()),
    capabilities: ModelCapabilityGuess,
    /** LM Studio / llama.cpp / Ollama: the model is in memory now (absent when unknown). */
    loaded: Type.Optional(Type.Boolean()),
  },
  { $id: "ProbedModel" },
);
export type ProbedModel = Static<typeof ProbedModel>;

/**
 * Endpoint probe state. `not_probed` until the owner asks (probes never run on their own);
 * `auth_failed` when the server answered 401/403; `unreachable` when nothing answered.
 */
export const EndpointProbeState = StringEnum(
  ["not_probed", "reachable", "unreachable", "auth_failed", "error"],
  { $id: "EndpointProbeState" },
);
export type EndpointProbeState = Static<typeof EndpointProbeState>;

export const EndpointProbe = Type.Object(
  {
    state: EndpointProbeState,
    probedAt: Type.Optional(IsoDateTime),
    latencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Server software when it said (`llama.cpp`, `LM Studio`, `Ollama 0.12.3`). */
    server: Type.Optional(Type.String()),
    models: Type.Array(ProbedModel),
    /** Short, redacted reason for `unreachable` / `auth_failed` / `error`. */
    error: Type.Optional(Type.String()),
  },
  { $id: "EndpointProbe" },
);
export type EndpointProbe = Static<typeof EndpointProbe>;

/** Six-case tool-calling check verdict (B4). `untested` until it runs. */
export const ToolCheckStatus = StringEnum(["untested", "agent-capable", "chat-only"], {
  $id: "ToolCheckStatus",
});
export type ToolCheckStatus = Static<typeof ToolCheckStatus>;

export const ToolCheckResult = Type.Object(
  {
    ref: ModelRef,
    status: ToolCheckStatus,
    passed: Type.Integer({ minimum: 0 }),
    total: Type.Integer({ minimum: 0 }),
    /** A case could not reach the model; the verdict was not stored. */
    inconclusive: Type.Boolean(),
    probedAt: Type.Optional(IsoDateTime),
  },
  { $id: "ToolCheckResult" },
);
export type ToolCheckResult = Static<typeof ToolCheckResult>;

/** A model a provider is known to serve: from its config, a role binding or the last probe. */
export const ProviderModelEntry = Type.Object(
  {
    ref: ModelRef,
    capabilities: Type.Optional(ModelCapabilityGuess),
    toolCheck: ToolCheckStatus,
  },
  { $id: "ProviderModelEntry" },
);
export type ProviderModelEntry = Static<typeof ProviderModelEntry>;

export const ModelProviderSummary = Type.Object(
  {
    /** Ref prefix (`anthropic`, `lmstudio`, `llamacpp-big`). */
    id: Type.String({ minLength: 1, maxLength: 64 }),
    /**
     * Provider family: `anthropic`, `openai`, `google`, `openrouter`, `openai-compatible`,
     * `anthropic-compatible`, `ollama`, `llamacpp`, `lmstudio`; new families are added here.
     */
    kind: Type.String({ minLength: 1, maxLength: 64 }),
    label: Type.String(),
    /** Endpoint (never carries a key). */
    baseURL: Type.Optional(Type.String()),
    /** Runs on the owner's machine: no key, no cost. */
    local: Type.Boolean(),
    /** At least one credential profile is configured (the key itself stays in the vault). */
    keyConfigured: Type.Boolean(),
    models: Type.Array(ProviderModelEntry),
    probe: EndpointProbe,
  },
  { $id: "ModelProviderSummary" },
);
export type ModelProviderSummary = Static<typeof ModelProviderSummary>;

/**
 * Roles the owner picks in Settings (the router also has embedding, vision and speech).
 */
export const PickableModelRole = StringEnum(["primary", "utility"], {
  $id: "PickableModelRole",
});
export type PickableModelRole = Static<typeof PickableModelRole>;

export const ModelRoles = Type.Object(
  {
    primary: Type.Optional(ModelRef),
    utility: Type.Optional(ModelRef),
  },
  { $id: "ModelRoles" },
);
export type ModelRoles = Static<typeof ModelRoles>;
