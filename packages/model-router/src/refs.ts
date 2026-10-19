import { type ModelRef, PsycheError } from "@psyche/protocol";

/** Roles a `router/<role>` ref selects (architecture §4.4). */
export const MODEL_ROLES = ["primary", "utility", "embedding", "vision", "speech"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** Provider id the router answers to: `router/primary` resolves the primary role chain. */
export const ROUTER_PROVIDER_ID = "router";

const PROVIDER_ID = /^[a-z0-9][a-z0-9_.-]*$/;

export interface ParsedModelRef {
  provider: string;
  model: string;
}

/** Split `provider/model` at the first slash. Model ids may contain slashes (OpenRouter). */
export function parseModelRef(ref: ModelRef): ParsedModelRef {
  const slash = ref.indexOf("/");
  const provider = slash > 0 ? ref.slice(0, slash) : "";
  const model = slash > 0 ? ref.slice(slash + 1) : "";
  if (!PROVIDER_ID.test(provider) || model.length === 0) {
    throw new PsycheError("invalid_params", `invalid model ref "${ref}" (want provider/model)`);
  }
  return { provider, model };
}

export function formatModelRef(provider: string, model: string): ModelRef {
  return `${provider}/${model}`;
}

export function isModelRole(value: string): value is ModelRole {
  return (MODEL_ROLES as readonly string[]).includes(value);
}

/** The role a `router/<role>` ref names, or undefined for a concrete ref. */
export function roleOf(ref: ModelRef): ModelRole | undefined {
  const { provider, model } = parseModelRef(ref);
  if (provider !== ROUTER_PROVIDER_ID) return undefined;
  if (!isModelRole(model)) {
    throw new PsycheError("invalid_params", `unknown model role "${model}"`);
  }
  return model;
}
