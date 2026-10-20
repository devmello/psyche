import type { Clock, CredentialBroker } from "@psyche/protocol";
import { AiSdkAdapter } from "./adapter.ts";
import { CliAdapter, type CliAdapterDeps } from "./cli/adapter.ts";
import { cliDialectFor } from "./cli/index.ts";
import { isSubscriptionKind, type ProviderConfig } from "./config.ts";
import type { CooldownPolicy } from "./cooldown.ts";
import { brokerKeySource, type KeySource, NO_KEYS } from "./credentials.ts";
import type { UsageLedger } from "./ledger.ts";
import { Prices } from "./prices.ts";
import type { ProbeStore } from "./probe.ts";
import type { ModelRole } from "./refs.ts";
import { ModelRouter, type PrepareStep, type RoleBinding } from "./router.ts";

export interface ModelRouterConfig {
  providers: ProviderConfig[];
  roles?: Partial<Record<ModelRole, RoleBinding>>;
  cooldown?: CooldownPolicy;
  probeOnFirstUse?: boolean;
  autoModeAllowlist?: (string | RegExp)[];
}

export interface ModelRouterDeps {
  clock: Clock;
  /** Provider keys come only from the vault (B6). Omit for keyless local setups. */
  credentials?: CredentialBroker;
  /** Overrides `credentials` (live tests read env keys through this). */
  keys?: KeySource;
  ledger?: UsageLedger;
  probes?: ProbeStore;
  prices?: Prices;
  prepareStep?: PrepareStep;
  fetch?: typeof fetch;
  /** Subscription CLIs (`claude-code`, `codex`): bridge and environment (tests use a fake CLI). */
  cli?: CliAdapterDeps;
}

/** Build adapters for each provider config and the router over them. */
export function createModelRouter(config: ModelRouterConfig, deps: ModelRouterDeps): ModelRouter {
  const keys =
    deps.keys ?? (deps.credentials === undefined ? NO_KEYS : brokerKeySource(deps.credentials));
  const prices = deps.prices ?? new Prices();
  const adapterDeps: ConstructorParameters<typeof AiSdkAdapter>[1] = { keys, prices };
  if (deps.fetch !== undefined) adapterDeps.fetch = deps.fetch;
  const options: ConstructorParameters<typeof ModelRouter>[0] = {
    providers: config.providers.map((p) =>
      isSubscriptionKind(p.kind)
        ? new CliAdapter(p, cliDialectFor(p), deps.cli)
        : new AiSdkAdapter(p, adapterDeps),
    ),
    clock: deps.clock,
  };
  if (config.roles !== undefined) options.roles = config.roles;
  if (config.cooldown !== undefined) options.cooldown = config.cooldown;
  if (config.probeOnFirstUse !== undefined) options.probeOnFirstUse = config.probeOnFirstUse;
  if (config.autoModeAllowlist !== undefined) options.autoModeAllowlist = config.autoModeAllowlist;
  if (deps.ledger !== undefined) options.ledger = deps.ledger;
  if (deps.probes !== undefined) options.probes = deps.probes;
  if (deps.prepareStep !== undefined) options.prepareStep = deps.prepareStep;
  return new ModelRouter(options);
}
