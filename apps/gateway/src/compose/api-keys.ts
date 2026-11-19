import type { HashChainAuditLog } from "@psyche/audit";
import {
  type MethodParams,
  type MethodResult,
  PsycheError,
  ResolvedSecret,
} from "@psyche/protocol";
import { BRAVE_ORIGIN } from "@psyche/search";
import type { Vault } from "@psyche/vault";
import type { Call, HandlerDef } from "../context.ts";
import {
  clearModelKey,
  type HostedModelKind,
  hasModelKey,
  MODEL_KEY_ENV,
  storeModelKey,
} from "./model-keys.ts";

/**
 * `keys.status` / `keys.set` / `keys.clear` (setup without a terminal): the hosted providers'
 * API keys and the Brave Search key, settable from Settings. Each is a Gateway-owned vault item
 * (like a channel secret): bound to its API origin, refused to every agent fill, read per request
 * inside `ResolvedSecret.use`. An environment variable still wins when it is set, so owner setups
 * keep working. Nothing here returns a key, any part of one, or writes one to the audit log.
 */

export type ApiKeyId = MethodParams<"keys.set">["id"];
export type ApiKeyStatus = MethodResult<"keys.set">["status"];

export const API_KEY_IDS: readonly ApiKeyId[] = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "brave",
];

/** The environment variable each key still honours (and that wins over the vault). */
export const API_KEY_ENV: Record<ApiKeyId, string> = {
  ...MODEL_KEY_ENV,
  brave: "PSYCHE_SEARCH_BRAVE_KEY",
};

/** How a key is named in a notice to the owner. */
export const API_KEY_LABEL: Record<ApiKeyId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  brave: "Brave Search",
};

/** The vault owner id (and slug) of the Brave key; `model-` keeps it Gateway-owned. */
export const BRAVE_OWNER = "model-brave-search";

/** The key an environment variable holds, trimmed, or undefined when unset or blank. */
export function envKey(
  env: Readonly<Record<string, string | undefined>>,
  id: ApiKeyId,
): string | undefined {
  const v = env[API_KEY_ENV[id]]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

/** Whether the vault holds the key (metadata is readable while the vault is locked). */
export function hasVaultKey(vault: Vault | undefined, id: ApiKeyId): boolean {
  if (vault === undefined) return false;
  return id === "brave" ? vault.connectorItem(BRAVE_OWNER) !== undefined : hasModelKey(vault, id);
}

export function apiKeyStatus(
  vault: Vault | undefined,
  env: Readonly<Record<string, string | undefined>>,
  id: ApiKeyId,
): ApiKeyStatus {
  const inVault = hasVaultKey(vault, id);
  const fromEnv = envKey(env, id) !== undefined;
  return {
    id,
    configured: fromEnv || inVault,
    source: fromEnv ? "env" : inVault ? "vault" : null,
    inVault,
  };
}

/** Keys with no whitespace, control or non-ASCII characters: what every provider issues. */
export function normalizeBraveKey(raw: string): string {
  const key = raw
    .trim()
    .replace(/^(["'`])(.*)\1$/s, "$2")
    .trim();
  if (key === "") {
    throw new PsycheError("invalid_params", "the key is empty", {
      details: { reason: "key_empty" },
    });
  }
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new PsycheError(
      "invalid_params",
      "the key contains spaces, line breaks or characters an API key never has",
      { details: { reason: "key_characters" } },
    );
  }
  return key;
}

/**
 * The Brave key as a one-shot secret from the vault. An agent's web search must never raise the
 * vault's Touch ID / password prompt (that is for payments only), so a locked vault is an error
 * here and never an unlock. An environment key, when set, is used before this is reached.
 */
export async function braveVaultSecret(vault: () => Vault | undefined): Promise<ResolvedSecret> {
  const v = vault();
  const item = v?.connectorItem(BRAVE_OWNER);
  if (v === undefined || item === undefined) {
    throw new PsycheError("unavailable", "no web search key yet: add it in Settings", {
      details: { reason: "search_key_missing" },
    });
  }
  if (v.locked) {
    throw new PsycheError(
      "unavailable",
      "the web search key is in the locked vault; unlock Psyche to search",
      { details: { reason: "vault_locked" } },
    );
  }
  return v.accessToken(item.id, BRAVE_OWNER);
}

export function braveEnvSecret(key: string, envName: string): ResolvedSecret {
  return new ResolvedSecret(key, {
    credentialId: `env:${envName}`,
    target: { kind: "origin", value: BRAVE_ORIGIN },
  });
}

async function storeBraveKey(vault: Vault, pasted: string): Promise<void> {
  const key = normalizeBraveKey(pasted);
  const existing = vault.connectorItem(BRAVE_OWNER);
  if (existing !== undefined) {
    await vault.replaceConnectorTokens(existing.id, BRAVE_OWNER, { accessToken: key });
    return;
  }
  await vault.store({
    connectorId: BRAVE_OWNER,
    slug: BRAVE_OWNER,
    name: "Brave Search API key (web search)",
    bindings: [{ connector: BRAVE_OWNER }, { origin: BRAVE_ORIGIN }],
    tokens: { accessToken: key },
  });
}

async function clearBraveKey(vault: Vault): Promise<boolean> {
  const existing = vault.connectorItem(BRAVE_OWNER);
  if (existing === undefined) return false;
  await vault.revoke(existing.id, BRAVE_OWNER, "deleted");
  return true;
}

export interface ApiKeyHandlerDeps {
  vault: () => Vault | undefined;
  env: Readonly<Record<string, string | undefined>>;
  audit: Pick<HashChainAuditLog, "append">;
  /** Runs after a key was stored or cleared (web search re-reads its provider). */
  onChanged?: (id: ApiKeyId) => void;
  /**
   * False when the model keys come from the environment (`PSYCHE_MODEL`): `keys.set` and
   * `keys.clear` for a model provider then refuse, like `models.setKey`. Brave is unaffected.
   */
  modelKeysInVault?: boolean;
  /** Tells the owner a key was replaced or removed, without the key (the notify path). */
  onKeyReplaced?: (change: {
    id: ApiKeyId;
    action: "changed" | "removed";
    deviceId: string;
  }) => void;
}

const ENV_MODE_ERROR =
  "this Gateway reads provider keys from its environment (PSYCHE_MODEL is set)";

/** `keys.*`. Params are never logged; the audit entry holds the provider id and action only. */
export function apiKeyHandlers(deps: ApiKeyHandlerDeps): Record<string, HandlerDef> {
  const open = (): Vault => {
    const v = deps.vault();
    if (v === undefined) throw new PsycheError("unavailable", "the vault is not set up");
    return v;
  };
  const audited = (call: Call, action: "set" | "clear", id: ApiKeyId): Promise<unknown> =>
    deps.audit.append({
      kind: `keys.${action}`,
      actor: { type: "device", deviceId: call.identity.deviceId },
      data: { provider: id },
    });
  return {
    "keys.status": {
      run(): MethodResult<"keys.status"> {
        const v = deps.vault();
        return { keys: API_KEY_IDS.map((id) => apiKeyStatus(v, deps.env, id)) };
      },
    },
    "keys.set": {
      async run(call: Call, params: MethodParams<"keys.set">): Promise<MethodResult<"keys.set">> {
        if (params.id !== "brave" && deps.modelKeysInVault === false) {
          throw new PsycheError("unavailable", ENV_MODE_ERROR);
        }
        const v = open();
        const replaced = hasVaultKey(v, params.id);
        try {
          if (params.id === "brave") await storeBraveKey(v, params.key);
          else await storeModelKey(v, params.id as HostedModelKind, params.key);
        } catch (err) {
          // A raw error could quote its input: only the Gateway's own errors pass through.
          if (err instanceof PsycheError && err.code !== "internal") throw err;
          throw new PsycheError("unavailable", "the key could not be stored");
        }
        await audited(call, "set", params.id);
        deps.onChanged?.(params.id);
        if (replaced) {
          deps.onKeyReplaced?.({
            id: params.id,
            action: "changed",
            deviceId: call.identity.deviceId,
          });
        }
        return { status: apiKeyStatus(v, deps.env, params.id) };
      },
    },
    "keys.clear": {
      async run(
        call: Call,
        params: MethodParams<"keys.clear">,
      ): Promise<MethodResult<"keys.clear">> {
        if (params.id !== "brave" && deps.modelKeysInVault === false) {
          throw new PsycheError("unavailable", ENV_MODE_ERROR);
        }
        const v = open();
        const removed =
          params.id === "brave"
            ? await clearBraveKey(v)
            : await clearModelKey(v, params.id as HostedModelKind);
        // Idempotent: clearing an absent key succeeds and records nothing.
        if (removed) {
          await audited(call, "clear", params.id);
          deps.onChanged?.(params.id);
          deps.onKeyReplaced?.({
            id: params.id,
            action: "removed",
            deviceId: call.identity.deviceId,
          });
        }
        return { status: apiKeyStatus(v, deps.env, params.id) };
      },
    },
  };
}

/**
 * A device as the key-changed notice names it. A paired device picks its own name, so it is
 * shown as quoted data: control and bidi characters are stripped, whitespace collapsed, the
 * length clamped. The facts the Gateway holds itself (platform, pairing date) follow it.
 */
export function describeKeyActor(
  device: { name: string; platform: string; pairedAt?: string | null | undefined } | undefined,
): string {
  const parts = keyActorParts(device);
  if (parts === undefined) return "a device";
  return `"${parts.device}" (${parts.platform}${parts.paired === "none" ? "" : `, paired ${parts.paired}`})`;
}

/** The same facts as separate, cleaned values (the `notice.apiKey.changed` message's params). */
export function keyActorParts(
  device: { name: string; platform: string; pairedAt?: string | null | undefined } | undefined,
): { device: string; platform: string; paired: string } | undefined {
  if (device === undefined) return undefined;
  const name = device.name
    .replace(/[\p{Cc}\p{Cf}\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const clamped = [...name].length > 40 ? `${[...name].slice(0, 39).join("")}…` : name;
  const paired = /^\d{4}-\d{2}-\d{2}/.test(device.pairedAt ?? "")
    ? (device.pairedAt ?? "").slice(0, 10)
    : "none";
  return { device: clamped, platform: device.platform, paired };
}
