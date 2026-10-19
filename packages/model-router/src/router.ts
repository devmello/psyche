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
import { isLocalKind } from "./config.ts";
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
}

export const DEFAULT_AUTO_MODE_ALLOWLIST: RegExp[] = [
  /^anthropic\/claude-(?:fable-5-1|opus-5-5|sonnet-5-5)$/,
  /^openai\/gpt-6(?:\.1)?-(?:astra|sol)$/,
  /^google\/gemini-4-argon$/,
];

interface Plan {
  chain: ModelRef[];
  strict: boolean;
  role: ModelRole | undefined;
  request: ModelRequest;
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

  /** Whether a model may run threads in `auto` permission mode. */
  allowsAutoMode(ref: ModelRef): boolean {
    const list = this.#o.autoModeAllowlist ?? DEFAULT_AUTO_MODE_ALLOWLIST;
    return list.some((p) => (typeof p === "string" ? p === ref : p.test(ref)));
  }

  #bindingFor(role: ModelRole): RoleBinding | undefined {
    const b = this.#roles.get(role);
    if (b !== undefined) return b;
    // Utility and vision default to the primary chain; embedding and speech must be bound.
    return role === "utility" || role === "vision" ? this.#roles.get("primary") : undefined;
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
      return {
        chain: strict ? [binding.model] : [binding.model, ...(binding.fallbacks ?? [])],
        strict,
        role,
        request: req,
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
    const chain = plan.strict ? plan.chain.slice(0, 1) : live.length > 0 ? live : plan.chain;
    const tried: string[] = [];
    let last: ModelCallError | undefined;

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
        for await (const event of provider.stream({ ...plan.request, model: ref }, callOpts)) {
          if (event.type === "finish") {
            finish = event;
            break;
          }
          if (event.type === "usage") usage = event.usage;
          if (isContent(event)) content = true;
          yield event;
        }
        if (usage !== undefined) await this.#record(ref, usage, outcome, options);
        const fin = finish ?? { type: "finish", reason: "stop" };
        if (fin.reason !== "error") {
          if (fin.reason !== "cancelled") {
            this.#cooldowns.succeed(profileKey(pid, profileId));
            this.#cooldowns.succeed(providerKey(pid));
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
