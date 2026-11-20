import { Type } from "@sinclair/typebox";
import { defineMethod } from "./define.ts";

/**
 * `keys.*` (setup without a terminal): the model providers' API keys and the web search key,
 * set from Settings instead of environment variables. Write-only: nothing here ever returns a key.
 */
export const ApiKeyId = Type.Union(
  [
    Type.Literal("anthropic"),
    Type.Literal("openai"),
    Type.Literal("google"),
    Type.Literal("openrouter"),
    Type.Literal("brave"),
  ],
  { $id: "ApiKeyId" },
);

export const ApiKeyStatus = Type.Object(
  {
    id: ApiKeyId,
    /** Whether a key is in effect for this id. */
    configured: Type.Boolean(),
    /** Where the key in effect comes from: an environment variable always wins over the vault. */
    source: Type.Union([Type.Literal("env"), Type.Literal("vault"), Type.Null()]),
    /** True when the vault holds a key too (an environment one is in effect over it). */
    inVault: Type.Boolean(),
  },
  { $id: "ApiKeyStatus" },
);

export const KeysMethods = {
  "keys.status": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ keys: Type.Array(ApiKeyStatus) }),
    scope: "operator.admin",
    description:
      "Which provider API keys and the web search key are configured, and whether each comes from an environment variable or the vault. Never returns a key or any part of one.",
  }),
  "keys.set": defineMethod({
    params: Type.Object({
      id: ApiKeyId,
      /** The key. Stored in the vault; never logged, echoed or returned. */
      key: Type.String({ minLength: 1, maxLength: 4096 }),
    }),
    result: Type.Object({ status: ApiKeyStatus }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Stores a provider API key (anthropic, openai, google, openrouter) or the Brave Search key (brave) in the vault as a Gateway-owned item, replacing an earlier one, and returns its status. The Gateway uses it from the next request, no restart. An environment variable still wins when set. invalid_params for an empty key, one with whitespace or one the provider cannot accept; unavailable when the vault cannot be opened. Audited (provider only). Side-effecting; its params are never logged.",
  }),
  "keys.clear": defineMethod({
    params: Type.Object({ id: ApiKeyId }),
    result: Type.Object({ status: ApiKeyStatus }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Removes the vault's key for a provider or the web search key and returns its status. Idempotent: clearing an absent key succeeds. An environment variable is not touched. Audited (provider only). Side-effecting.",
  }),
} as const;
