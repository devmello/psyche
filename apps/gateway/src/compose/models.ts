import {
  type KeySource,
  type ModelRouterConfig,
  type ProviderConfig,
  type ProviderKind,
  parseModelRef,
} from "@psyche/model-router";
import { PsycheError, ResolvedSecret } from "@psyche/protocol";
import type { ModelSetup } from "./index.ts";

/**
 * Model setup from the environment, for `psyched` in development and the live skeleton test:
 * `PSYCHE_MODEL=<provider>/<model>` (and optionally `PSYCHE_UTILITY_MODEL`). Hosted keys come from
 * the provider's usual variable and stay inside the router's `KeySource`; they never reach the
 * model, logs or transcripts. Settings → Model & providers with vault keys (S03/S06) replaces this.
 */

const KEY_ENV: Partial<Record<ProviderKind, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const KINDS: readonly ProviderKind[] = ["anthropic", "openai", "google", "openrouter", "ollama"];

function envKeys(env: NodeJS.ProcessEnv, names: string[]): KeySource {
  const values = () => names.map((n) => env[n]).filter((v): v is string => !!v);
  return {
    resolve: async (profile, target) => {
      const name = profile.id.startsWith("env:") ? profile.id.slice(4) : undefined;
      const v = name === undefined ? undefined : env[name];
      return v ? new ResolvedSecret(v, { credentialId: `env:${name}`, target }) : undefined;
    },
    redact: (text) => values().reduce((t, v) => t.split(v).join("•••"), text),
  };
}

export function modelSetupFromEnv(env: NodeJS.ProcessEnv): ModelSetup | null {
  const primary = env.PSYCHE_MODEL;
  if (!primary) return null;
  const utility = env.PSYCHE_UTILITY_MODEL ?? primary;
  const providers = new Map<string, ProviderConfig>();
  const keyNames: string[] = [];
  for (const ref of [primary, utility]) {
    const { provider } = parseModelRef(ref);
    if (providers.has(provider)) continue;
    const kind = KINDS.find((k) => k === provider);
    if (kind === undefined) {
      throw new PsycheError(
        "invalid_params",
        `PSYCHE_MODEL provider ${provider} is not supported here`,
      );
    }
    const keyEnv = KEY_ENV[kind];
    const config: ProviderConfig = { id: provider, kind };
    if (kind === "ollama" && env.PSYCHE_OLLAMA_URL) config.baseURL = env.PSYCHE_OLLAMA_URL;
    if (keyEnv !== undefined) {
      if (!env[keyEnv]) throw new PsycheError("invalid_params", `${keyEnv} is not set`);
      config.profiles = [{ id: `env:${keyEnv}`, credential: "{{cred:env}}" }];
      keyNames.push(keyEnv);
    }
    providers.set(provider, config);
  }
  const router: ModelRouterConfig = {
    providers: [...providers.values()],
    roles: { primary: { model: primary }, utility: { model: utility } },
  };
  return { router, keys: envKeys(env, keyNames) };
}

/**
 * Until the owner picks a model (onboarding step "model"), turns end with a clear error instead
 * of the Gateway refusing to start: memory, approvals and Settings stay usable.
 */
export const NO_MODEL: ModelSetup = {
  provider: {
    id: "none",
    async *stream() {
      yield {
        type: "text_delta",
        text: "No model is configured yet. Pick one in Settings → Model & providers.",
      };
      yield { type: "finish", reason: "error" };
    },
    capabilities: async () => ({
      toolCalling: false,
      vision: false,
      reasoning: false,
      embeddings: false,
    }),
  },
  model: "none/none",
};
