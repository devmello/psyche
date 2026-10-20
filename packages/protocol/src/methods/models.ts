import { Type } from "@sinclair/typebox";
import { ModelRef } from "../common.ts";
import {
  ModelProviderSummary,
  ModelRoles,
  PickableModelRole,
  ToolCheckResult,
} from "../schemas/models.ts";
import { defineMethod } from "./define.ts";

/**
 * `models.*` (feature B1, B4; architecture §4.4): Settings → Model & providers. Probes and
 * checks reach the provider, so they run only when the owner asks and need `operator.admin`.
 */
export const ModelsMethods = {
  "models.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ providers: Type.Array(ModelProviderSummary), roles: ModelRoles }),
    scope: "operator.read",
    description:
      "Lists the configured model providers with their known models, the last endpoint probe (state not_probed until one runs) and tool-check verdicts, plus the primary and utility role bindings.",
  }),
  "models.probe": defineMethod({
    params: Type.Object({ providerId: Type.String({ minLength: 1, maxLength: 64 }) }),
    result: Type.Object({ provider: ModelProviderSummary }),
    scope: "operator.admin",
    description:
      "Probes one configured provider's endpoint: reachability, the model list and capability guesses (vision, tool use, context length). Stores and returns the result. not_found for an unknown provider id.",
  }),
  "models.check": defineMethod({
    params: Type.Object({ ref: ModelRef }),
    result: Type.Object({ result: ToolCheckResult }),
    scope: "operator.admin",
    description:
      "Runs the six-case tool-calling check (B4) on one model and stores a conclusive verdict. Calls the model, so it may cost tokens.",
  }),
  "models.setRole": defineMethod({
    params: Type.Object({
      role: PickableModelRole,
      ref: ModelRef,
      /** Use a chat-only model as primary anyway (B4). */
      override: Type.Optional(Type.Boolean()),
    }),
    result: Type.Object({ roles: ModelRoles }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Binds the primary or utility role to a model and persists it (settings models.primary / models.utility). policy_denied when a chat-only model is picked as primary without override; not_found when no configured provider serves the ref. Side-effecting.",
  }),
  "models.setKey": defineMethod({
    params: Type.Object({
      providerId: Type.String({ minLength: 1, maxLength: 64 }),
      /** The provider's API key. Stored in the vault; never logged, echoed or returned. */
      key: Type.String({ minLength: 1, maxLength: 4096 }),
    }),
    result: Type.Object({ provider: ModelProviderSummary }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Stores a hosted provider's API key in the vault as a Gateway-owned item bound to the provider's API origin (replacing an earlier one) and returns the provider with keyConfigured true. The model router reads it per request; agents can never fill it. not_found for an unknown provider id, invalid_params for a keyless (local) provider, unavailable when the vault cannot be opened. Side-effecting; its params are never logged.",
  }),
} as const;
