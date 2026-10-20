import { getSetting, type PsycheDb, setSetting } from "@psyche/db";
import {
  AiSdkAdapter,
  defaultBaseURL,
  type EndpointProbeResult,
  type EndpointProbeStore,
  isLocalKind,
  type KeySource,
  KeyValueEndpointProbeStore,
  type KeyValueStore,
  type ModelRouter,
  NOT_PROBED,
  type ProviderConfig,
  type ProviderKind,
  parseModelRef,
  probeEndpoint,
} from "@psyche/model-router";
import {
  type Clock,
  type MethodParams,
  type MethodResult,
  type ModelProviderSummary,
  type ModelRef,
  type ModelRoles,
  PsycheError,
  type ToolCheckStatus,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { type HostedModelKind, isHostedModelKind } from "./model-keys.ts";

/**
 * Settings → Model & providers (feature B1, B4; architecture §4.4): `models.list`,
 * `models.probe`, `models.check` and `models.setRole` over the model router. Probes and checks
 * reach the provider, so they run only when the owner asks. Role picks persist as the
 * `models.primary` / `models.utility` settings and are re-applied at boot.
 */

export const ROLE_SETTING = { primary: "models.primary", utility: "models.utility" } as const;

const KIND_LABEL: Record<ProviderKind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  "openai-compatible": "OpenAI-compatible server",
  "anthropic-compatible": "Anthropic-compatible server",
  ollama: "Ollama",
  llamacpp: "llama.cpp",
  lmstudio: "LM Studio",
};

export interface ModelSettingsSetup {
  db: PsycheDb;
  /** Absent when the Gateway runs a fixed provider (CI fakes, no model configured). */
  router?: ModelRouter;
  providers: readonly ProviderConfig[];
  keys?: KeySource;
  clock: Clock;
  /** Probe transport (tests replay fixtures through this). */
  fetch?: typeof fetch;
  /** The fixed provider's model when there is no router. */
  fixedModel?: ModelRef;
  endpoints?: EndpointProbeStore;
  /** Hosted keys kept in the vault (model-keys.ts): `models.setKey` and `keyConfigured`. */
  vaultKeys?: {
    has(providerId: string): boolean;
    store(providerId: HostedModelKind, key: string): Promise<void>;
  };
}

export function settingsKeyValue(db: PsycheDb): KeyValueStore {
  return {
    get: (key) => getSetting(db, key)?.value,
    set: (key, value) => {
      setSetting(db, key, value);
    },
  };
}

function adapterOf(router: ModelRouter | undefined, id: string): AiSdkAdapter | undefined {
  const p = router?.provider(id);
  return p instanceof AiSdkAdapter ? p : undefined;
}

/**
 * Boot: re-apply the owner's role picks (they were checked when picked) and the facts the last
 * endpoint probes learned. A pick whose provider is no longer configured is skipped.
 */
export async function restoreModelSettings(setup: ModelSettingsSetup): Promise<void> {
  const { router, db } = setup;
  if (router === undefined) return;
  const endpoints = setup.endpoints ?? new KeyValueEndpointProbeStore(settingsKeyValue(db));
  for (const config of setup.providers) {
    const probe = await endpoints.get(config.id);
    if (probe?.state === "reachable") adapterOf(router, config.id)?.learn(probe.models);
  }
  for (const role of ["primary", "utility"] as const) {
    const ref = getSetting(db, ROLE_SETTING[role])?.value;
    if (typeof ref !== "string") continue;
    try {
      if (router.provider(parseModelRef(ref).provider) === undefined) continue;
      await router.setRole(role, { ...router.role(role), model: ref }, { override: true });
    } catch {
      // A malformed stored ref keeps the configured binding.
    }
  }
}

export function modelSettingsHandlers(setup: ModelSettingsSetup): Record<string, HandlerDef> {
  const { db, router, clock } = setup;
  const endpoints = setup.endpoints ?? new KeyValueEndpointProbeStore(settingsKeyValue(db));
  const configs = new Map(setup.providers.map((p) => [p.id, p]));

  const roles = (): ModelRoles => {
    const out: ModelRoles = {};
    if (router === undefined) {
      if (setup.fixedModel !== undefined) out.primary = setup.fixedModel;
      return out;
    }
    const primary = router.role("primary")?.model;
    const utility = router.role("utility")?.model;
    if (primary !== undefined) out.primary = primary;
    if (utility !== undefined) out.utility = utility;
    return out;
  };

  const toolCheck = async (ref: ModelRef): Promise<ToolCheckStatus> =>
    (await router?.probeResult(ref))?.status ?? "untested";

  const summary = async (config: ProviderConfig): Promise<ModelProviderSummary> => {
    const probe: EndpointProbeResult = (await endpoints.get(config.id)) ?? NOT_PROBED;
    const chains = (["primary", "utility"] as const).flatMap((role) => {
      const b = router?.role(role);
      return b === undefined ? [] : [b.model, ...(b.fallbacks ?? [])];
    });
    const bound = [...Object.values(roles()), ...chains].filter(
      (ref): ref is ModelRef => ref !== undefined && parseModelRef(ref).provider === config.id,
    );
    const refs = new Set<ModelRef>([
      ...bound,
      ...Object.keys(config.models ?? {}).map((m) => `${config.id}/${m}`),
      ...probe.models.map((m) => m.ref),
    ]);
    const facts = new Map(probe.models.map((m) => [m.ref, m.capabilities]));
    const models: ModelProviderSummary["models"] = [];
    for (const ref of refs) {
      const capabilities = facts.get(ref);
      models.push({
        ref,
        toolCheck: await toolCheck(ref),
        ...(capabilities === undefined ? {} : { capabilities }),
      });
    }
    const baseURL = defaultBaseURL(config);
    return {
      id: config.id,
      kind: config.kind,
      label: KIND_LABEL[config.kind] ?? config.id,
      ...(baseURL === undefined ? {} : { baseURL }),
      local: isLocalKind(config.kind),
      keyConfigured:
        setup.vaultKeys !== undefined && isHostedModelKind(config.id)
          ? setup.vaultKeys.has(config.id)
          : (config.profiles ?? []).some((p) => p.credential !== undefined),
      models,
      probe: structuredClone(probe),
    };
  };

  const needRouter = (): ModelRouter => {
    if (router === undefined) {
      throw new PsycheError("unavailable", "no model router is configured (fixed provider)");
    }
    return router;
  };

  return {
    "models.list": {
      async run(): Promise<MethodResult<"models.list">> {
        const providers: ModelProviderSummary[] = [];
        for (const config of configs.values()) providers.push(await summary(config));
        return { providers, roles: roles() };
      },
    },
    "models.probe": {
      async run(
        _call: Call,
        params: MethodParams<"models.probe">,
      ): Promise<MethodResult<"models.probe">> {
        const config = configs.get(params.providerId);
        if (config === undefined) {
          throw new PsycheError("not_found", `no model provider "${params.providerId}"`);
        }
        const result = await probeEndpoint(config, {
          clock,
          ...(setup.keys === undefined ? {} : { keys: setup.keys }),
          ...(setup.fetch === undefined ? {} : { fetch: setup.fetch }),
        });
        await endpoints.set(config.id, result);
        if (result.state === "reachable") adapterOf(router, config.id)?.learn(result.models);
        return { provider: await summary(config) };
      },
    },
    "models.check": {
      async run(
        _call: Call,
        params: MethodParams<"models.check">,
      ): Promise<MethodResult<"models.check">> {
        const r = await needRouter().probe(params.ref);
        return {
          result: {
            ref: r.ref,
            status: r.inconclusive ? "untested" : r.status,
            passed: r.passed,
            total: r.total,
            inconclusive: r.inconclusive,
            probedAt: r.probedAt,
          },
        };
      },
    },
    "models.setKey": {
      async run(
        _call: Call,
        params: MethodParams<"models.setKey">,
      ): Promise<MethodResult<"models.setKey">> {
        const config = configs.get(params.providerId);
        if (config === undefined) {
          throw new PsycheError("not_found", `no model provider "${params.providerId}"`);
        }
        if (!isHostedModelKind(config.id) || isLocalKind(config.kind)) {
          throw new PsycheError("invalid_params", `${config.id} takes no API key`);
        }
        if (setup.vaultKeys === undefined) {
          throw new PsycheError(
            "unavailable",
            "this Gateway reads provider keys from its environment (PSYCHE_MODEL is set)",
          );
        }
        try {
          await setup.vaultKeys.store(config.id, params.key);
        } catch (err) {
          // Never let a raw error (which could quote its input) reach the dispatcher's log.
          if (err instanceof PsycheError && err.code !== "internal") throw err;
          throw new PsycheError("internal", "models.setKey failed");
        }
        return { provider: await summary(config) };
      },
    },
    "models.setRole": {
      async run(
        call: Call,
        params: MethodParams<"models.setRole">,
      ): Promise<MethodResult<"models.setRole">> {
        const r = needRouter();
        const { provider } = parseModelRef(params.ref);
        if (r.provider(provider) === undefined) {
          throw new PsycheError("not_found", `no configured provider serves ${params.ref}`);
        }
        // Keep the configured fallbacks; the pick replaces only the role's model.
        await r.setRole(
          params.role,
          { ...r.role(params.role), model: params.ref },
          params.override === undefined ? {} : { override: params.override },
        );
        const entry = setSetting(db, ROLE_SETTING[params.role], params.ref);
        call.emit("settings.changed", { entries: [entry] });
        return { roles: roles() };
      },
    },
  };
}
