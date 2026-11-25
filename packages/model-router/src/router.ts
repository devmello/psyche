import {
  type CallOptions,
  type Clock,
  type JsonObject,
  type ModelCapabilities,
  type ModelEvent,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  PsycheError,
  type Usage,
} from "@psyche/protocol";
import { AiSdkAdapter, type CallOutcome, type EmbedTaskOptions } from "./adapter.ts";
import { isFreeLocalProvider, isLocalKind, type ProviderKind } from "./config.ts";
import {
  type CooldownPolicy,
  type CooldownState,
  Cooldowns,
  profileKey,
  providerKey,
} from "./cooldown.ts";
import { ModelCallError, type ModelErrorKind, ROUTING } from "./errors.ts";
import type { UsageLedger } from "./ledger.ts";
import {
  InMemoryProbeStore,
  type ProbeResult,
  type ProbeStore,
  runCapabilityProbe,
} from "./probe.ts";
import { type ModelRole, parseModelRef, ROUTER_PROVIDER_ID, roleOf } from "./refs.ts";

/** A role's model and its ordered fallbacks (data model §10 `model_roles`). */
export interface RoleBinding {
  model: ModelRef;
  fallbacks?: ModelRef[];
}

export interface PrepareStepContext {
  step: number;
  request: ModelRequest;
  /** True when the user pinned the model; a swap returned by the hook is then ignored. */
  strict: boolean;
  threadId: string | undefined;
}

/** `prepareStep`-style hook (AI SDK v7 vocabulary): swap the model or options for one step. */
export type PrepareStep = (
  ctx: PrepareStepContext,
) =>
  | { model?: ModelRef; providerOptions?: Record<string, JsonObject> }
  | undefined
  | Promise<{ model?: ModelRef; providerOptions?: Record<string, JsonObject> } | undefined>;

export interface RouterCallOptions extends CallOptions {
  /** Thread whose `/model` override applies to `router/primary`. */
  threadId?: string;
  runId?: string;
  /** Job id for scheduled / background calls (usage rows). */
  job?: string;
  /** The ref was picked by the user: never change model, fail visibly. */
  strict?: boolean;
  step?: number;
  prepareStep?: PrepareStep;
}

export interface ModelRouterOptions {
  providers: ModelProvider[];
  roles?: Partial<Record<ModelRole, RoleBinding>>;
  clock: Clock;
  cooldown?: CooldownPolicy;
  ledger?: UsageLedger;
  probes?: ProbeStore;
  /** Run the capability probe the first time a local model is used with tools. */
  probeOnFirstUse?: boolean;
  prepareStep?: PrepareStep;
  /**
   * Models allowed to run threads in `auto` permission mode (architecture §4.4: published
   * prompt-injection resistance). Others are capped at `balanced`.
   */
  autoModeAllowlist?: (string | RegExp)[];
  /** Same-model retry of transient failures before any content streamed. Off unless set (`createModelRouter` turns it on with the defaults). */
  retry?: RetryPolicy | false;
}

/** Retry of one model call on a transient error, before the router cools down or falls back. */
export interface RetryPolicy {
  /** Retries after the first call (default 3). */
  retries?: number;
  /** Backoff base delays in ms, one per retry (default 1 s, 3 s, 8 s). */
  delaysMs?: number[];
  /** Longest wait for any retry, `retryAfterSec` included (default 30 s). */
  maxDelayMs?: number;
  /** Jitter source in [0, 1) (default `Math.random`). */
  random?: () => number;
}

/** Errors worth another try of the same call: the provider or the network, not the request. */
const RETRYABLE_KINDS: ReadonlySet<ModelErrorKind> = new Set([
  "rate_limited",
  "overloaded",
  "server_error",
  "timeout",
  "network",
]);

/** Wait `ms`, ending early (returning false) when the signal aborts. */
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (isAborted(signal)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Which models may run Auto by default, matched on the provider's KIND and the model name, never
 * on the provider id: a provider the owner named `anthropic` that is really an
 * `anthropic-compatible` endpoint, or an `openai-compatible` one, gets nothing. These are the
 * current tool-calling chat models of the three big labs, the small tiers included (Haiku, luna,
 * flash: the owner decided on 2026-11-09 that Auto may run on them although they resist prompt
 * injection less well), and the models of the two subscription CLIs (`default` is whatever the
 * CLI's own default is). Older generations, previews, local models and other providers stay at
 * `balanced`: the owner can take the one-tap "Switch to <model>" offer, or widen the list with
 * `autoModeAllowlist` (which matches the full ref).
 */
export const AUTO_MODE_KIND_RULES: readonly { kind: string; model: RegExp }[] = [
  {
    kind: "anthropic",
    model: /^claude-(?:fable-5(?:-1)?|opus-5(?:-5)?|sonnet-5(?:-5)?|haiku-5-5)$/,
  },
  { kind: "openai", model: /^(?:gpt-6-(?:astra|sol|luna)|gpt-6\.1-sol)$/ },
  { kind: "google", model: /^(?:gemini-4-argon|gemini-3\.8-flash)$/ },
  { kind: "claude-code", model: /^(?:opus|sonnet|haiku|default)$/ },
  { kind: "codex", model: /^default$/ },
];

/**
 * The cheap model each provider kind binds to the `utility` role while the owner has picked none.
 * Titles, compaction, the evaluator, search cards and the profile learner run there, so they stay
 * off the primary model's price. Only models that are known to exist and to be priced are
 * listed; a kind that is not here (Codex, OpenAI, Google, local servers) keeps the old
 * fallback to the primary chain, and jobs that must never bill the primary skip instead.
 * All of them are on the Auto-mode allowlist above, so the choice never widens it.
 */
/** How long a derived cheap model that proved missing or forbidden stays off before it is tried again. */
export const CHEAP_BAD_MS = 3_600_000;

export const CHEAP_UTILITY_BY_KIND: Readonly<Record<string, string>> = {
  anthropic: "claude-haiku-5-5",
  "claude-code": "haiku",
};

/**
 * The same rules as full refs, for a Gateway that has no router to ask for a provider's kind (the
 * default provider id of each kind is the kind itself).
 */
export const DEFAULT_AUTO_MODE_ALLOWLIST: RegExp[] = AUTO_MODE_KIND_RULES.map(
  (r) => new RegExp(`^${r.kind}/${r.model.source.slice(1)}`),
);

interface Plan {
  chain: ModelRef[];
  strict: boolean;
  role: ModelRole | undefined;
  request: ModelRequest;
  /** The derived cheap utility model leading the chain, if this call runs on it. */
  cheap?: ModelRef;
}

export interface ProviderHealth {
  id: string;
  kind: string;
  cooldowns: CooldownState[];
}

const FAILURE_KINDS = new Set(Object.keys(ROUTING));

/** Kind of a `finish.error` (`<kind>: message`) from any provider, ours or not. */
function errorFromFinish(error: string | undefined): ModelCallError {
  const text = error ?? "unknown: model call failed";
  const i = text.indexOf(":");
  const kind = i > 0 ? text.slice(0, i) : "";
  if (FAILURE_KINDS.has(kind))
    return new ModelCallError(kind as ModelErrorKind, text.slice(i + 1).trim());
  return new ModelCallError("unknown", text);
}

const isContent = (e: ModelEvent) =>
  e.type === "text_delta" ||
  e.type === "tool_call" ||
  e.type === "reasoning" ||
  e.type === "tool_result";

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * The model router (architecture §4.4, B2). A `ModelProvider` whose id is `router`:
 * `router/primary` resolves the primary role with its fallbacks, a concrete `provider/model`
 * goes straight to that provider. Inside a provider, auth profiles rotate before the router
 * moves to the next model; failing profiles and providers cool down. Fallback only happens
 * before the first content event of a call (after that the stream ends with the error). A
 * user-pinned model (`strict`, or a thread's `/model`) never changes and fails visibly.
 */
export class ModelRouter implements ModelProvider {
  readonly id = ROUTER_PROVIDER_ID;
  readonly #providers = new Map<string, ModelProvider>();
  readonly #roles = new Map<ModelRole, RoleBinding>();
  readonly #threads = new Map<string, ModelRef>();
  readonly #cooldowns: Cooldowns;
  readonly #probes: ProbeStore;
  readonly #o: ModelRouterOptions;
  readonly #probing = new Map<ModelRef, Promise<ProbeResult>>();
  /** Derived cheap utility models that proved unusable, with the time the latch lapses. */
  readonly #cheapBad = new Map<ModelRef, number>();

  constructor(options: ModelRouterOptions) {
    this.#o = options;
    for (const p of options.providers) {
      if (p.id === ROUTER_PROVIDER_ID)
        throw new PsycheError("invalid_params", `provider id "${p.id}" is reserved`);
      this.#providers.set(p.id, p);
    }
    for (const [role, binding] of Object.entries(options.roles ?? {})) {
      if (binding === undefined) continue;
      for (const ref of [binding.model, ...(binding.fallbacks ?? [])]) parseModelRef(ref);
      this.#roles.set(role as ModelRole, structuredClone(binding));
    }
    this.#cooldowns = new Cooldowns(options.clock, options.cooldown);
    this.#probes = options.probes ?? new InMemoryProbeStore();
  }

  provider(id: string): ModelProvider | undefined {
    return this.#providers.get(id);
  }

  /** Every provider in the registry; refs are `<provider id>/<model id>`. */
  providers(): ModelProvider[] {
    return [...this.#providers.values()];
  }

  role(role: ModelRole): RoleBinding | undefined {
    const b = this.#roles.get(role);
    return b === undefined ? undefined : structuredClone(b);
  }

  /** The probe verdict for a ref, if it was probed. */
  async probeResult(ref: ModelRef): Promise<ProbeResult | undefined> {
    return this.#probes.get(ref);
  }

  async #assertAgentCapable(refs: ModelRef[], override: boolean): Promise<void> {
    if (override) return;
    for (const ref of refs) {
      const r = await this.#probes.get(ref);
      if (r?.status === "chat-only") {
        throw new PsycheError(
          "policy_denied",
          `${ref} failed the tool-calling probe (${r.passed}/${r.total}) and is chat-only; pass override to use it for agent threads`,
          { details: { ref, probe: r } },
        );
      }
    }
  }

  /** Bind a role. A chat-only model cannot become `primary` without `override` (B4). */
  async setRole(
    role: ModelRole,
    binding: RoleBinding,
    options: { override?: boolean } = {},
  ): Promise<void> {
    for (const ref of [binding.model, ...(binding.fallbacks ?? [])]) parseModelRef(ref);
    if (role === "primary") {
      await this.#assertAgentCapable(
        [binding.model, ...(binding.fallbacks ?? [])],
        options.override === true,
      );
    }
    this.#roles.set(role, structuredClone(binding));
  }

  /** Per-thread `/model`: strict for that thread's `router/primary` calls. `undefined` clears it. */
  async setThreadModel(
    threadId: string,
    ref: ModelRef | undefined,
    options: { override?: boolean } = {},
  ): Promise<void> {
    if (ref === undefined) {
      this.#threads.delete(threadId);
      return;
    }
    parseModelRef(ref);
    await this.#assertAgentCapable([ref], options.override === true);
    this.#threads.set(threadId, ref);
  }

  threadModel(threadId: string): ModelRef | undefined {
    return this.#threads.get(threadId);
  }

  /**
   * Whether a model may run threads in `auto` permission mode: the owner's own allowlist if one
   * is configured (full refs), else the default rules, matched on the provider's kind. A
   * provider that is not a configured endpoint (a test fake, a custom provider) counts by its id.
   */
  allowsAutoMode(ref: ModelRef): boolean {
    const own = this.#o.autoModeAllowlist;
    if (own !== undefined)
      return own.some((p) => (typeof p === "string" ? p === ref : p.test(ref)));
    let parsed: { provider: string; model: string };
    try {
      parsed = parseModelRef(ref);
    } catch {
      return false;
    }
    const { provider: id, model } = parsed;
    const configured = (this.#providers.get(id) as { config?: { kind?: string } } | undefined)
      ?.config?.kind;
    const kind = configured ?? id;
    return AUTO_MODE_KIND_RULES.some((r) => r.kind === kind && r.model.test(model));
  }

  /**
   * The cheap default for an unset utility role: the primary model's provider, with the model
   * `CHEAP_UTILITY_BY_KIND` names for its kind. Only for the provider's stock endpoint (a custom
   * `baseURL` is a proxy or gateway that may not serve that model) and only until the cheap
   * model has failed as missing or forbidden (`#cheapBad`): then the role is the primary again.
   * Any other failure must not quietly move the work onto the primary model's price.
   */
  #cheapUtility(): RoleBinding | undefined {
    const primary = this.#roles.get("primary");
    if (primary === undefined) return undefined;
    let id: string;
    try {
      id = parseModelRef(primary.model).provider;
    } catch {
      return undefined;
    }
    const config = (this.#providers.get(id) as { config?: { kind?: string; baseURL?: string } })
      ?.config;
    // Match on the adapter's kind, never on a provider id the owner chose.
    if (config?.kind === undefined || config.baseURL !== undefined) return undefined;
    const model = CHEAP_UTILITY_BY_KIND[config.kind];
    if (model === undefined) return undefined;
    const ref = `${id}/${model}`;
    return this.#isCheapBad(ref) ? undefined : { model: ref };
  }

  #isCheapBad(ref: ModelRef): boolean {
    const until = this.#cheapBad.get(ref);
    if (until === undefined) return false;
    if (this.#o.clock.now() < until) return true;
    this.#cheapBad.delete(ref); // the latch lapsed: Haiku is tried again
    return false;
  }

  #latchCheapBad(ref: ModelRef): void {
    this.#cheapBad.set(ref, this.#o.clock.now() + CHEAP_BAD_MS);
  }

  /**
   * The concrete model of the `utility` role when it is not a paid fallback to the primary: the
   * owner's pick, else the provider's cheap default, else the primary itself when it is local
   * (free). `undefined` means the role would bill the primary, so background jobs that must
   * never do that (search cards) skip.
   */
  utilityRef(): ModelRef | undefined {
    const own = this.#roles.get("utility") ?? this.#cheapUtility();
    if (own !== undefined) return own.model;
    const primary = this.#roles.get("primary");
    if (primary === undefined) return undefined;
    try {
      const config = (
        this.#providers.get(parseModelRef(primary.model).provider) as {
          config?: { kind: ProviderKind; baseURL?: string };
        }
      )?.config;
      return config !== undefined && isFreeLocalProvider(config) ? primary.model : undefined;
    } catch {
      return undefined;
    }
  }

  #bindingFor(role: ModelRole): RoleBinding | undefined {
    const b = this.#roles.get(role);
    if (b !== undefined) return b;
    // Utility is the provider's cheap model when it has one; utility and vision otherwise
    // default to the primary chain. Embedding and speech must be bound.
    if (role === "utility") return this.#cheapUtility() ?? this.#roles.get("primary");
    return role === "vision" ? this.#roles.get("primary") : undefined;
  }

  async #plan(request: ModelRequest, options: RouterCallOptions): Promise<Plan> {
    let req = request;
    const pinnedThread =
      options.threadId === undefined ? undefined : this.#threads.get(options.threadId);
    const initialRole = roleOf(req.model);
    const strictUpfront =
      options.strict === true || (initialRole === "primary" && pinnedThread !== undefined);
    const hook = options.prepareStep ?? this.#o.prepareStep;
    if (hook !== undefined) {
      const swap = await hook({
        step: options.step ?? 0,
        request: req,
        strict: strictUpfront,
        threadId: options.threadId,
      });
      if (swap?.providerOptions !== undefined) {
        const merged: Record<string, JsonObject> = { ...req.providerOptions };
        for (const [k, v] of Object.entries(swap.providerOptions))
          merged[k] = { ...merged[k], ...v };
        req = { ...req, providerOptions: merged };
      }
      if (swap?.model !== undefined && !strictUpfront) req = { ...req, model: swap.model };
    }
    const role = roleOf(req.model);
    if (role === "primary" && pinnedThread !== undefined) {
      return { chain: [pinnedThread], strict: true, role, request: req };
    }
    if (role !== undefined) {
      const binding = this.#bindingFor(role);
      if (binding === undefined)
        throw new ModelCallError("model_not_found", `no model is bound to role ${role}`);
      // `strict` on a role ref pins the role's model: no fallbacks.
      const strict = options.strict === true;
      // The derived cheap utility model leads the primary chain, but the chain is entered only
      // when the cheap model is missing or forbidden (see `stream`): the cheap default must not
      // turn compaction into a permanent failure where the primary works.
      const primary = this.#roles.get("primary");
      const cheap =
        role === "utility" && this.#roles.get("utility") === undefined
          ? this.#cheapUtility()?.model
          : undefined;
      const rest =
        cheap !== undefined && primary !== undefined
          ? [primary.model, ...(primary.fallbacks ?? [])]
          : (binding.fallbacks ?? []);
      return {
        chain: strict ? [binding.model] : [binding.model, ...rest],
        strict,
        role,
        request: req,
        ...(cheap === undefined ? {} : { cheap }),
      };
    }
    return { chain: [req.model], strict: options.strict === true, role, request: req };
  }

  #profiles(provider: ModelProvider): (string | undefined)[] {
    if (!(provider instanceof AiSdkAdapter)) return [undefined];
    const all = provider.profiles().map((p) => p?.id);
    const fresh = all.filter((id) => !this.#cooldowns.isCooling(profileKey(provider.id, id)));
    return fresh.length > 0 ? fresh : all;
  }

  async #maybeProbe(
    provider: ModelProvider,
    ref: ModelRef,
    request: ModelRequest,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (this.#o.probeOnFirstUse !== true || (request.tools?.length ?? 0) === 0) return;
    if (!(provider instanceof AiSdkAdapter) || !isLocalKind(provider.config.kind)) return;
    try {
      if ((await this.#probes.get(ref)) !== undefined) return;
      await this.probe(ref, signal === undefined ? {} : { signal });
    } catch {
      // A probe failure must not fail the call; the next first use tries again.
    }
  }

  /** Run (or join a running) capability probe for `ref` and persist the verdict. */
  async probe(
    ref: ModelRef,
    options: { signal?: AbortSignal; caseTimeoutMs?: number } = {},
  ): Promise<ProbeResult> {
    const running = this.#probing.get(ref);
    if (running !== undefined) return running;
    const provider = this.#providers.get(parseModelRef(ref).provider);
    if (provider === undefined) throw new PsycheError("not_found", `no provider for ${ref}`);
    const opts: Parameters<typeof runCapabilityProbe>[2] = { now: () => this.#o.clock.now() };
    if (options.signal !== undefined) opts.signal = options.signal;
    if (options.caseTimeoutMs !== undefined) opts.caseTimeoutMs = options.caseTimeoutMs;
    const p = runCapabilityProbe(provider, ref, opts).then(async (r) => {
      // A server that was down or a cancelled run says nothing about the model: keep no verdict.
      if (!r.inconclusive) await this.#probes.set(r);
      return r;
    });
    this.#probing.set(ref, p);
    try {
      return await p;
    } finally {
      this.#probing.delete(ref);
    }
  }

  async #record(
    ref: ModelRef,
    usage: Usage,
    outcome: CallOutcome | undefined,
    options: RouterCallOptions,
  ) {
    const ledger = this.#o.ledger;
    if (ledger === undefined) return;
    const input: Parameters<UsageLedger["record"]>[0] = { modelRef: ref, usage };
    if (options.runId !== undefined) input.runId = options.runId;
    if (options.job !== undefined) input.job = options.job;
    if (outcome?.unpriced === true) input.unpriced = true;
    try {
      await ledger.record(input);
    } catch {
      // Accounting must never break a model call (the stream contract forbids throwing).
    }
  }

  async *stream(request: ModelRequest, options: RouterCallOptions = {}): AsyncIterable<ModelEvent> {
    const signal = options.signal;
    if (isAborted(signal)) {
      yield { type: "finish", reason: "cancelled" };
      return;
    }
    let plan: Plan;
    try {
      plan = await this.#plan(request, options);
    } catch (err) {
      const e =
        err instanceof ModelCallError
          ? err
          : new ModelCallError("bad_request", (err as Error).message);
      yield { type: "finish", reason: "error", error: e.toFinishError() };
      return;
    }

    const live = plan.chain.filter((ref) => {
      const pid = parseModelRef(ref).provider;
      return !this.#cooldowns.isCooling(providerKey(pid));
    });
    // A call on the derived cheap model never goes to the primary's cross-provider fallbacks just
    // because the shared provider is cooling: it tries the cheap model (and fails with its error).
    const cheapCooling = plan.cheap !== undefined && !live.includes(plan.cheap);
    const chain = plan.strict
      ? plan.chain.slice(0, 1)
      : cheapCooling
        ? [plan.cheap as ModelRef]
        : live.length > 0
          ? live
          : plan.chain;
    const tried: string[] = [];
    let last: ModelCallError | undefined;
    // The cheap model failed `auth`: the key may be fine and the model forbidden, or the key may
    // be the problem (a locked vault, a transient 401). Only the primary working on the same
    // profile in this call tells them apart.
    let cheapAuth: { profileId: string | undefined } | undefined;

    for (const ref of chain) {
      const pid = parseModelRef(ref).provider;
      const provider = this.#providers.get(pid);
      if (provider === undefined) {
        last = new ModelCallError("model_not_found", `no provider "${pid}" for ${ref}`);
        tried.push(`${ref}: model_not_found`);
        if (plan.strict) break;
        continue;
      }
      await this.#maybeProbe(provider, ref, plan.request, signal);
      let rotateFailures = 0;
      const profiles = this.#profiles(provider);
      for (const profileId of profiles) {
        if (isAborted(signal)) {
          yield { type: "finish", reason: "cancelled" };
          return;
        }
        let outcome: CallOutcome | undefined;
        let finish: Extract<ModelEvent, { type: "finish" }> | undefined;
        let usage: Usage | undefined;
        let content = false;
        const callOpts: RouterCallOptions & {
          profileId?: string;
          onOutcome: (o: CallOutcome) => void;
        } = {
          onOutcome: (o) => {
            outcome = o;
          },
        };
        if (signal !== undefined) callOpts.signal = signal;
        if (profileId !== undefined) callOpts.profileId = profileId;
        const retry = this.#o.retry === false ? undefined : this.#o.retry;
        const maxRetries = retry === undefined ? 0 : (retry.retries ?? 3);
        let attempt = 0;
        let cancelledInBackoff = false;
        for (;;) {
          outcome = undefined;
          finish = undefined;
          // Anything the consumer has seen that a second attempt would repeat.
          let streamed = false;
          for await (const event of provider.stream({ ...plan.request, model: ref }, callOpts)) {
            if (event.type === "finish") {
              finish = event;
              break;
            }
            if (event.type === "usage") usage = event.usage;
            if (isContent(event)) content = true;
            if (isContent(event) || event.type === "tool_input") streamed = true;
            yield event;
          }
          if (finish?.reason !== "error" || streamed || attempt >= maxRetries) break;
          const failure =
            (outcome as CallOutcome | undefined)?.error ?? errorFromFinish(finish.error);
          if (!RETRYABLE_KINDS.has(failure.kind)) break;
          // Another auth profile is the better answer to a rate limit than waiting.
          if (failure.kind === "rate_limited" && profiles.length > 1) break;
          const r = retry ?? {};
          const maxDelay = r.maxDelayMs ?? 30_000;
          const bases = r.delaysMs ?? [1000, 3000, 8000];
          const base = bases[Math.min(attempt, bases.length - 1)] ?? 1000;
          const jitter = 0.8 + 0.4 * (r.random ?? Math.random)();
          const wait = Math.min(
            maxDelay,
            failure.retryAfterSec !== undefined ? failure.retryAfterSec * 1000 : base * jitter,
          );
          attempt += 1;
          if (usage !== undefined)
            await this.#record(ref, usage, outcome as CallOutcome | undefined, options);
          usage = undefined;
          if (!(await abortableSleep(wait, signal))) {
            cancelledInBackoff = true;
            break;
          }
        }
        if (cancelledInBackoff) {
          yield { type: "finish", reason: "cancelled" };
          return;
        }
        if (usage !== undefined) await this.#record(ref, usage, outcome, options);
        const fin = finish ?? { type: "finish", reason: "stop" };
        if (fin.reason !== "error") {
          if (fin.reason !== "cancelled") {
            this.#cooldowns.succeed(profileKey(pid, profileId));
            this.#cooldowns.succeed(providerKey(pid));
            if (
              cheapAuth !== undefined &&
              plan.cheap !== undefined &&
              ref !== plan.cheap &&
              pid === parseModelRef(plan.cheap).provider &&
              profileId === cheapAuth.profileId
            )
              this.#latchCheapBad(plan.cheap);
          }
          yield fin;
          return;
        }
        const err = outcome?.error ?? errorFromFinish(fin.error);
        if (err.kind === "cancelled") {
          yield { type: "finish", reason: "cancelled" };
          return;
        }
        last = err;
        tried.push(`${ref}${profileId === undefined ? "" : `#${profileId}`}: ${err.kind}`);
        const routing = ROUTING[err.kind];
        // The derived cheap utility model. `model_not_found`: it is not served here (a plan or
        // workspace without it); latch it off for an hour and go to the primary chain. `auth`: try
        // the primary, and latch only if it works on the same profile. Neither cools the provider
        // (the primary shares it), and after text has streamed neither latches or cools: the call
        // just ends. Any other failure of the cheap model ends the call: it must not quietly
        // bill the primary.
        if (ref === plan.cheap) {
          const unusable = err.kind === "model_not_found" || err.kind === "auth";
          if (unusable && !content) {
            if (err.kind === "model_not_found") this.#latchCheapBad(ref);
            else cheapAuth = { profileId };
            break;
          }
          if (!unusable && routing.cooldown) {
            const key = routing.rotateProfile ? profileKey(pid, profileId) : providerKey(pid);
            this.#cooldowns.fail(key, err.kind, err.retryAfterSec);
          }
          yield { type: "finish", reason: "error", error: err.toFinishError() };
          return;
        }
        if (routing.cooldown) {
          const key = routing.rotateProfile ? profileKey(pid, profileId) : providerKey(pid);
          this.#cooldowns.fail(key, err.kind, err.retryAfterSec);
        }
        // Content already reached the consumer, or the request itself is bad: stop here.
        if (content || (!routing.fallback && !routing.rotateProfile)) {
          yield { type: "finish", reason: "error", error: err.toFinishError() };
          return;
        }
        if (!routing.rotateProfile) break;
        rotateFailures += 1;
      }
      if (rotateFailures > 0 && rotateFailures === profiles.length && last !== undefined) {
        this.#cooldowns.fail(providerKey(pid), last.kind, last.retryAfterSec);
      }
      if (plan.strict || (last !== undefined && !ROUTING[last.kind].fallback)) break;
    }

    const e = last ?? new ModelCallError("unknown", "no model was tried");
    const message = plan.strict
      ? `${e.kind}: ${chain[0]} is pinned and failed (no fallback): ${e.message}`
      : `${e.kind}: every model failed (${tried.join("; ")}): ${e.message}`;
    yield { type: "finish", reason: "error", error: message };
  }

  async #embeddingTarget(
    model: ModelRef | undefined,
  ): Promise<{ provider: ModelProvider; ref: ModelRef }> {
    let ref = model ?? `${ROUTER_PROVIDER_ID}/embedding`;
    const role = roleOf(ref);
    if (role !== undefined) {
      const b = this.#roles.get(role);
      if (b === undefined) throw new PsycheError("not_found", `no model is bound to role ${role}`);
      ref = b.model;
    }
    const provider = this.#providers.get(parseModelRef(ref).provider);
    if (provider?.embed === undefined)
      throw new PsycheError("not_found", `no embedding provider for ${ref}`);
    return { provider, ref };
  }

  /** Embed through the `embedding` role (or `options.model`). No fallback: dimensions differ. */
  async embed(texts: string[], options: EmbedTaskOptions = {}): Promise<number[][]> {
    const { provider, ref } = await this.#embeddingTarget(options.model);
    const embed = provider.embed;
    if (embed === undefined) throw new PsycheError("not_found", `no embedding provider for ${ref}`);
    return embed.call(provider, texts, { ...options, model: ref });
  }

  /** The embedding model and its dimension, for the memory index (S07). */
  async embeddingInfo(): Promise<{ model: ModelRef; dimensions: number }> {
    const { provider, ref } = await this.#embeddingTarget(undefined);
    if (provider instanceof AiSdkAdapter) {
      return {
        model: ref,
        dimensions: await provider.embeddingDimensions(parseModelRef(ref).model),
      };
    }
    const [v] = await this.embed(["dimension probe"]);
    return { model: ref, dimensions: v?.length ?? 0 };
  }

  async capabilities(model?: ModelRef): Promise<ModelCapabilities> {
    let ref = model ?? `${ROUTER_PROVIDER_ID}/primary`;
    const role = roleOf(ref);
    if (role !== undefined) {
      const b = this.#bindingFor(role);
      if (b === undefined) throw new PsycheError("not_found", `no model is bound to role ${role}`);
      ref = b.model;
    }
    const provider = this.#providers.get(parseModelRef(ref).provider);
    if (provider === undefined) throw new PsycheError("not_found", `no provider for ${ref}`);
    const caps = await provider.capabilities(ref);
    const probe = await this.#probes.get(ref);
    return probe?.status === "chat-only" ? { ...caps, toolCalling: false } : caps;
  }

  /** Provider list with live cooldowns (provider health panel, M2). */
  health(): ProviderHealth[] {
    const all = this.#cooldowns.snapshot();
    return [...this.#providers.values()].map((p) => ({
      id: p.id,
      kind: p instanceof AiSdkAdapter ? p.config.kind : "custom",
      cooldowns: all.filter(
        (c) => c.key === providerKey(p.id) || c.key.startsWith(`profile:${p.id}:`),
      ),
    }));
  }
}
