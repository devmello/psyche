import type {
  Grant,
  ModelProvider,
  ModelRef,
  SideEffect,
  Target,
  TargetKind,
} from "@psyche/protocol";
import { canonicalEmail, canonicalUrl } from "./targets.ts";
import type { ClassifierLabel, PolicyCall, PolicyContext } from "./types.ts";

/**
 * Auto-mode action classifier (security §3.8, architecture §4.6, feature F10). It runs after
 * steps 1–6 for residual `write` actions that would otherwise be allowed, and only ever sees the
 * owner's request and action metadata: never page text, screenshots, tool results, memory,
 * assistant text or untrusted content, and never agent-written goal text (design-08).
 * Any failure (unavailable, timeout, malformed, low confidence) is `sensitive`.
 */

export interface ClassifierInput {
  /** Owner-provenance request messages, last 10. */
  ownerMessages: string[];
  task: { title?: string; goal?: string; goalAuthoredBy?: "owner" | "agent"; goalTainted: boolean };
  tool: string;
  sideEffect: SideEffect;
  targetKind?: TargetKind;
  target?: string;
  /** Sizes, counts and amounts only, never values. */
  argMeta: Record<string, number | boolean>;
  grant?: { scope: Grant["scope"]; kind: Grant["kind"]; useCount: number };
  taint: { tainted: boolean; sourceKinds: string[]; origins: string[] };
  sensitiveTarget: boolean;
}

export interface ClassifierOutput {
  label: ClassifierLabel;
  reason: string;
  confidence?: number;
}

export interface ActionClassifier {
  readonly id: string;
  classify(input: ClassifierInput, signal: AbortSignal): Promise<ClassifierOutput>;
}

/** Numbers that describe the arguments without revealing them. */
export function argumentMetadata(params: unknown): Record<string, number | boolean> {
  const meta: Record<string, number | boolean> = {};
  if (typeof params !== "object" || params === null) return meta;
  for (const [rawKey, v] of Object.entries(params)) {
    // Keys come from the model's arguments: only plain identifiers reach the classifier (review #10).
    const k = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(rawKey) ? rawKey : "arg";
    if (typeof v === "string") meta[`${k}.length`] = v.length;
    else if (Array.isArray(v)) meta[`${k}.count`] = v.length;
    else if (typeof v === "boolean") meta[k] = v;
    else if (typeof v === "number" && /amount|qty|quantity|count|size|bytes|price/i.test(k))
      meta[k] = v;
  }
  return meta;
}

/** Canonical origin or addr-spec only; paths, argv and free text never reach the classifier. */
function classifierTarget(target: Target | undefined): string | undefined {
  if (target === undefined) return undefined;
  try {
    if (target.kind === "origin") return canonicalUrl(target.value).origin;
    if (target.kind === "recipient") return canonicalEmail(target.value).address;
    if (target.kind === "app" && /^[A-Za-z0-9.-]{1,200}$/.test(target.value)) return target.value;
  } catch {
    return undefined;
  }
  return undefined;
}

export function buildClassifierInput(
  call: PolicyCall,
  ctx: PolicyContext,
  extra: { grant?: Grant; sensitiveTarget: boolean },
): ClassifierInput {
  const sources = ctx.taintSources ?? [];
  const goalTainted =
    ctx.task?.goalTainted === true || (ctx.taint && ctx.task?.goalAuthoredBy !== "owner");
  const task: ClassifierInput["task"] = { goalTainted };
  if (ctx.task?.title !== undefined && ctx.task.goalAuthoredBy === "owner" && !goalTainted)
    task.title = ctx.task.title;
  if (ctx.task?.goal !== undefined && ctx.task.goalAuthoredBy === "owner" && !goalTainted)
    task.goal = ctx.task.goal;
  if (ctx.task?.goalAuthoredBy !== undefined) task.goalAuthoredBy = ctx.task.goalAuthoredBy;
  const input: ClassifierInput = {
    ownerMessages: (ctx.ownerMessages ?? []).slice(-10),
    task,
    tool: call.tool,
    sideEffect: call.sideEffect,
    argMeta: argumentMetadata(call.params),
    taint: {
      tainted: ctx.taint,
      sourceKinds: [...new Set(sources.map((s) => s.sourceKind))].sort(),
      origins: [
        ...new Set(sources.flatMap((s) => (s.origin === undefined ? [] : [s.origin]))),
      ].sort(),
    },
    sensitiveTarget: extra.sensitiveTarget,
  };
  if (call.targetKind !== undefined) input.targetKind = call.targetKind;
  const target = classifierTarget(call.target);
  if (target !== undefined) input.target = target;
  if (extra.grant !== undefined) {
    input.grant = {
      scope: extra.grant.scope,
      kind: extra.grant.kind,
      useCount: extra.grant.useCount,
    };
  }
  return input;
}

const SENSITIVE_TOOLS =
  /(delete|remove|revoke|share|invite|publish|post|forward|transfer|permission|settings|password|login|oauth|consent)/i;

/** Default: deterministic rules, no model. */
export class RulesClassifier implements ActionClassifier {
  readonly id = "rules";

  async classify(input: ClassifierInput): Promise<ClassifierOutput> {
    if (input.sideEffect === "financial")
      return { label: "prohibited", reason: "financial actions are never routine" };
    if (input.sideEffect !== "write")
      return { label: "sensitive", reason: `${input.sideEffect} is not routine` };
    if (input.taint.tainted)
      return { label: "sensitive", reason: "the turn read untrusted content" };
    if (input.task.goalTainted)
      return { label: "sensitive", reason: "the task goal came from a tainted turn" };
    if (input.sensitiveTarget) return { label: "sensitive", reason: "sensitive-category target" };
    if (SENSITIVE_TOOLS.test(input.tool))
      return { label: "sensitive", reason: `${input.tool} changes access or shares` };
    const bulk = Object.entries(input.argMeta).find(
      ([k, v]) => k.endsWith(".count") && typeof v === "number" && v > 20,
    );
    if (bulk !== undefined)
      return { label: "sensitive", reason: `bulk action (${bulk[0]} = ${bulk[1]})` };
    if (input.ownerMessages.length === 0)
      return { label: "sensitive", reason: "no owner request to align with" };
    return { label: "routine", reason: "write within existing grants, untainted" };
  }
}

export const CLASSIFIER_TIMEOUT_MS = 8000;
export const MIN_CONFIDENCE = 0.7;

const SYSTEM_PROMPT = `You label one proposed action of a personal AI agent for its owner.
You see only the owner's own requests and metadata about the action, never page content.
Answer with one JSON object and nothing else: {"label":"routine"|"sensitive"|"prohibited","confidence":0..1,"reason":"<short>"}.
routine: clearly what the owner asked for, reversible, low risk.
sensitive: plausible but the owner should confirm (new recipients, sharing, deleting, anything unclear).
prohibited: moves money, evades security, or contradicts the owner's request.`;

/** Model-backed classifier on the `utility` role (enabled by `classifier.model`). */
export class ModelClassifier implements ActionClassifier {
  readonly id: string;
  readonly #provider: ModelProvider;
  readonly #model: ModelRef;

  constructor(provider: ModelProvider, model: ModelRef) {
    this.#provider = provider;
    this.#model = model;
    this.id = `model:${model}`;
  }

  async classify(input: ClassifierInput, signal: AbortSignal): Promise<ClassifierOutput> {
    let text = "";
    const stream = this.#provider.stream(
      {
        model: this.#model,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", parts: [{ type: "text", text: JSON.stringify(input) }] }],
        toolChoice: "none",
        maxOutputTokens: 200,
        temperature: 0,
      },
      { signal },
    );
    for await (const ev of stream) {
      if (ev.type === "text_delta") text += ev.text;
      if (ev.type === "finish" && ev.reason !== "stop") {
        return { label: "sensitive", reason: `classifier finished with ${ev.reason}` };
      }
    }
    return parseClassifierOutput(text);
  }
}

export function parseClassifierOutput(text: string): ClassifierOutput {
  const m = /\{[\s\S]*\}/.exec(text);
  if (m === null) return { label: "sensitive", reason: "classifier output was not JSON" };
  try {
    const v = JSON.parse(m[0]) as { label?: unknown; confidence?: unknown; reason?: unknown };
    if (v.label !== "routine" && v.label !== "sensitive" && v.label !== "prohibited") {
      return { label: "sensitive", reason: "classifier label malformed" };
    }
    const confidence = typeof v.confidence === "number" ? v.confidence : 0;
    const reason = typeof v.reason === "string" ? v.reason.slice(0, 200) : "";
    if (v.label === "routine" && confidence < MIN_CONFIDENCE) {
      return { label: "sensitive", reason: `low confidence (${confidence})`, confidence };
    }
    return { label: v.label, reason, confidence };
  } catch {
    return { label: "sensitive", reason: "classifier output was not JSON" };
  }
}

/** Run a classifier with the timeout and fail-closed rules (security §3.8). */
export async function classifyFailClosed(
  classifier: ActionClassifier,
  input: ClassifierInput,
  timeoutMs = CLASSIFIER_TIMEOUT_MS,
): Promise<ClassifierOutput> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ClassifierOutput>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve({ label: "sensitive", reason: `classifier timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const out = await Promise.race([
      classifier.classify(input, ac.signal).catch(
        (e: unknown): ClassifierOutput => ({
          label: "sensitive",
          reason: `classifier unavailable: ${e instanceof Error ? e.message.slice(0, 100) : "error"}`,
        }),
      ),
      timeout,
    ]);
    if (out.label !== "routine" && out.label !== "sensitive" && out.label !== "prohibited") {
      return { label: "sensitive", reason: "classifier label malformed" };
    }
    return out;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
