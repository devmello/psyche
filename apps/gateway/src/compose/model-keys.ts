import type { KeySource, ProviderConfig, ProviderKind } from "@psyche/model-router";
import {
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  PsycheError,
  ResolvedSecret,
} from "@psyche/protocol";
import type { Vault } from "@psyche/vault";

/**
 * Hosted provider keys in the vault (first run from scratch: no environment variables). The
 * owner types a key once (onboarding's Model & provider step, `models.setKey`); the Gateway keeps
 * it as an item it owns, like a connector's OAuth token: bound to the provider's API origin,
 * refused to every agent fill (`connector_owned`) and read by the model router for each request,
 * inside `ResolvedSecret.use`, so it never sits in a provider object, log or transcript.
 */

export const HOSTED_MODEL_KINDS = ["anthropic", "openai", "google", "openrouter"] as const;
export type HostedModelKind = (typeof HOSTED_MODEL_KINDS)[number];

/** The origin each provider's requests go to; the item is bound to it. */
export const MODEL_API_ORIGIN: Record<HostedModelKind, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  google: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai",
};

/** The variable each provider's key is also read from; it wins over the vault (owner setups). */
export const MODEL_KEY_ENV: Record<HostedModelKind, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const LABEL: Record<HostedModelKind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  openrouter: "OpenRouter",
};

const PROFILE_PREFIX = "vault:";

/** The owner id (and slug) of a provider's key item: `model-anthropic`, … */
export function modelKeyOwner(providerId: string): string {
  return `model-${providerId}`;
}

export function isHostedModelKind(id: string): id is HostedModelKind {
  return (HOSTED_MODEL_KINDS as readonly string[]).includes(id);
}

/** Every hosted provider, each with one profile pointing at its vault item. */
export function hostedProviderConfigs(): ProviderConfig[] {
  return HOSTED_MODEL_KINDS.map((kind) => ({
    id: kind,
    kind: kind as ProviderKind,
    profiles: [
      {
        id: `${PROFILE_PREFIX}${modelKeyOwner(kind)}`,
        credential: `{{cred:${modelKeyOwner(kind)}}}`,
      },
    ],
  }));
}

/** Whether the provider's key item exists (the vault's metadata is readable while locked). */
export function hasModelKey(vault: Vault, providerId: string): boolean {
  return vault.connectorItem(modelKeyOwner(providerId)) !== undefined;
}

/** The router's `KeySource` over those items. */
export function vaultModelKeys(
  vault: () => Vault | undefined,
  env: Readonly<Record<string, string | undefined>> = {},
): KeySource {
  const fromEnv = (provider: string): { name: string; value: string } | undefined => {
    if (!isHostedModelKind(provider)) return undefined;
    const name = MODEL_KEY_ENV[provider];
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : { name, value };
  };
  return {
    async resolve(profile, target) {
      if (!profile.id.startsWith(PROFILE_PREFIX)) return undefined;
      const owner = profile.id.slice(PROFILE_PREFIX.length);
      const provider = owner.replace(/^model-/, "");
      // An environment variable wins over the vault, but only for the provider's own origin.
      const envKey = fromEnv(provider);
      if (envKey !== undefined) {
        if (target.value !== MODEL_API_ORIGIN[provider as HostedModelKind]) {
          throw new PsycheError("policy_denied", `the ${provider} key is bound to its API origin`, {
            details: { reason: "target_mismatch" },
          });
        }
        return new ResolvedSecret(envKey.value, { credentialId: `env:${envKey.name}`, target });
      }
      const v = vault();
      const item = v?.connectorItem(owner);
      if (v === undefined || item === undefined) {
        throw new PsycheError(
          "unavailable",
          `no ${provider} API key yet: add it in Settings → Model & providers`,
          { details: { reason: "model_key_missing", provider } },
        );
      }
      const origin = isHostedModelKind(provider) ? MODEL_API_ORIGIN[provider] : undefined;
      if (origin === undefined || target.value !== origin) {
        throw new PsycheError("policy_denied", `the ${provider} key is bound to ${origin}`, {
          details: { reason: "target_mismatch" },
        });
      }
      if (v.locked) {
        // Like a fill (`unlockOnFill`): the slot unlocks on first use after boot or the idle
        // lock (Touch ID with the Keychain slot, silent with a key file).
        try {
          await v.unlock(`Use your ${provider} API key`);
        } catch {
          throw new PsycheError("unavailable", "the vault is locked", {
            details: { reason: "vault_locked" },
          });
        }
      }
      return v.accessToken(item.id, owner);
    },
    redact: (text) =>
      HOSTED_MODEL_KINDS.reduce((t, k) => {
        const v = fromEnv(k)?.value;
        return v === undefined ? t : t.split(v).join("•••");
      }, vault()?.redact(text) ?? text),
  };
}

/** Invisible characters a copy from a web page or a PDF can carry along with a key. */
const INVISIBLE = /[\u00ad\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff]/g;

const keyError = (reason: string, message: string): PsycheError =>
  new PsycheError("invalid_params", message, { details: { reason } });

/**
 * The key as the provider expects it, from what the owner pasted (#504): surrounding spaces,
 * quotes, invisible characters and a pasted `Bearer ` / `x-api-key:` prefix are dropped. A key
 * that still holds whitespace or non-ASCII, or that is the wrong kind of credential, is refused
 * with a reason the Settings field can show, instead of being stored and refused later by the
 * provider as a bare 401. The error never quotes the key.
 */
export function normalizeModelKey(providerId: HostedModelKind, raw: string): string {
  let key = raw.replace(INVISIBLE, "").trim();
  key = key.replace(/^(?:authorization:\s*)?bearer\s+/i, "").replace(/^x-api-key:\s*/i, "");
  key = key.replace(/^(["'`])(.*)\1$/s, "$2").trim();
  if (key.length === 0) throw keyError("key_empty", "the key is empty");
  if (/\s/.test(key)) {
    throw keyError("key_whitespace", "the key contains spaces or line breaks; paste only the key");
  }
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw keyError("key_characters", "the key contains characters an API key never has");
  }
  if (providerId === "anthropic") {
    if (key.startsWith("sk-ant-oat")) {
      throw keyError(
        "subscription_token",
        "this is a Claude subscription sign-in token, not an API key: use the Claude Code (subscription) provider, or create an API key at console.anthropic.com",
      );
    }
    if (key.startsWith("sk-ant-admin")) {
      throw keyError(
        "admin_key",
        "this is an Anthropic Admin API key, which cannot call models: create a regular API key at console.anthropic.com",
      );
    }
    if (!key.startsWith("sk-ant-")) {
      throw keyError("key_shape", "Anthropic API keys start with sk-ant-; this one does not");
    }
  }
  return key;
}

/**
 * Removes a provider's key (`models.clearKey`, #511): the Gateway-owned item is revoked, which
 * also ends its grants and leases. Returns whether there was one.
 */
export async function clearModelKey(vault: Vault, providerId: HostedModelKind): Promise<boolean> {
  const owner = modelKeyOwner(providerId);
  const existing = vault.connectorItem(owner);
  if (existing === undefined) return false;
  await vault.revoke(existing.id, owner, "deleted");
  return true;
}

/** Stores (or replaces) a provider's key as a Gateway-owned vault item, normalized first. */
export async function storeModelKey(
  vault: Vault,
  providerId: HostedModelKind,
  pasted: string,
): Promise<void> {
  const key = normalizeModelKey(providerId, pasted);
  const owner = modelKeyOwner(providerId);
  const existing = vault.connectorItem(owner);
  if (existing !== undefined) {
    await vault.replaceConnectorTokens(existing.id, owner, { accessToken: key });
    return;
  }
  await vault.store({
    connectorId: owner,
    slug: owner,
    name: `${LABEL[providerId]} API key (models)`,
    bindings: [{ connector: owner }, { origin: MODEL_API_ORIGIN[providerId] }],
    tokens: { accessToken: key },
  });
}

const NOT_PICKED_TEXT =
  "No model is configured yet. Add a provider key and pick a model in Settings → Model & providers.";

/**
 * The router as the loop's provider, except that while no primary model is bound (a fresh
 * install before onboarding's model step) a turn says so instead of failing with a planner error.
 * Every other member is the router's own, bound to it, so router-only checks keep working.
 */
export function untilPrimaryPicked<R extends ModelProvider & { role(role: "primary"): unknown }>(
  router: R,
): R {
  async function* stream(request: ModelRequest, ...rest: unknown[]): AsyncIterable<ModelEvent> {
    // The roles that fall back to the primary chain (voice turns use `router/voice`).
    const routed =
      request.model === "router/primary" ||
      request.model === "router/utility" ||
      request.model === "router/voice";
    if (routed && router.role("primary") === undefined) {
      yield { type: "text_delta", text: NOT_PICKED_TEXT };
      yield { type: "finish", reason: "error" };
      return;
    }
    yield* (router.stream as (r: ModelRequest, ...a: unknown[]) => AsyncIterable<ModelEvent>).call(
      router,
      request,
      ...rest,
    );
  }
  return new Proxy(router, {
    get(target, prop) {
      if (prop === "stream") return stream;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
