import { APICallError } from "@ai-sdk/provider";
import { PsycheError } from "@psyche/protocol";

/**
 * Why a model call failed, in router terms. The kind decides what the router does next:
 * rotate to the next auth profile, cool the provider down, fall back to the next model, or
 * give up (see `ROUTING`).
 */
export type ModelErrorKind =
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "timeout"
  | "network"
  | "auth"
  | "billing"
  | "model_not_found"
  | "context_overflow"
  | "bad_request"
  | "content_filter"
  | "cancelled"
  | "unknown";

export interface Routing {
  /** Try the next auth profile of the same provider. */
  rotateProfile: boolean;
  /** Put the profile / provider in cooldown. */
  cooldown: boolean;
  /** Try the next model in the chain (non-strict only). */
  fallback: boolean;
}

export const ROUTING: Record<ModelErrorKind, Routing> = {
  rate_limited: { rotateProfile: true, cooldown: true, fallback: true },
  overloaded: { rotateProfile: false, cooldown: true, fallback: true },
  server_error: { rotateProfile: false, cooldown: true, fallback: true },
  timeout: { rotateProfile: false, cooldown: true, fallback: true },
  network: { rotateProfile: false, cooldown: true, fallback: true },
  auth: { rotateProfile: true, cooldown: true, fallback: true },
  billing: { rotateProfile: true, cooldown: true, fallback: true },
  model_not_found: { rotateProfile: false, cooldown: false, fallback: true },
  context_overflow: { rotateProfile: false, cooldown: false, fallback: true },
  bad_request: { rotateProfile: false, cooldown: false, fallback: false },
  content_filter: { rotateProfile: false, cooldown: false, fallback: false },
  cancelled: { rotateProfile: false, cooldown: false, fallback: false },
  unknown: { rotateProfile: false, cooldown: true, fallback: true },
};

/**
 * A classified provider failure. `message` is safe to show: it never carries request bodies
 * or headers, and the adapter passes it through `CredentialBroker.redact` first.
 */
export class ModelCallError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | undefined;
  /** Seconds the provider asked us to wait (`retry-after`), when it said. */
  readonly retryAfterSec: number | undefined;

  constructor(
    kind: ModelErrorKind,
    message: string,
    options: { status?: number; retryAfterSec?: number } = {},
  ) {
    super(message);
    this.name = "ModelCallError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterSec = options.retryAfterSec;
  }

  /** The text that goes into `finish.error`: `<kind>: <message>`. */
  toFinishError(): string {
    return `${this.kind}: ${this.message}`;
  }
}

const CONTEXT_OVERFLOW =
  /context[_ ]length|context window|prompt is too long|too many tokens|maximum context|input is too long|exceeds the (?:model'?s )?(?:maximum|context)/i;
const BILLING = /credit balance|insufficient[_ ]quota|billing|payment required|quota exceeded/i;
const MODEL_NOT_FOUND =
  /model[_ ]not[_ ]found|no such model|unknown model|model .* (?:does not exist|not found)|not_found_error/i;
const OVERLOADED = /overloaded/i;
const NETWORK =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|fetch failed|socket hang up|network/i;
const CONTENT_FILTER = /content[_ ]filter|safety|blocked by/i;

function retryAfter(headers: Record<string, string> | undefined): number | undefined {
  if (headers === undefined) return undefined;
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (raw === undefined) return undefined;
  const sec = Number(raw);
  return Number.isFinite(sec) && sec >= 0 ? sec : undefined;
}

function textOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const e = err as { message?: unknown; error?: { message?: unknown; type?: unknown } };
    if (typeof e.message === "string") return e.message;
    if (typeof e.error?.message === "string") {
      return typeof e.error.type === "string"
        ? `${e.error.type}: ${e.error.message}`
        : e.error.message;
    }
    try {
      return JSON.stringify(err).slice(0, 500);
    } catch {
      return "unknown error";
    }
  }
  return String(err);
}

function kindFromStatus(status: number, text: string): ModelErrorKind {
  if (status === 429) return BILLING.test(text) ? "billing" : "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  if (status === 404) return "model_not_found";
  if (status === 408) return "timeout";
  if (status === 413) return "context_overflow";
  if (status === 529 || OVERLOADED.test(text)) return "overloaded";
  if (status >= 500) return "server_error";
  if (status === 400 || status === 422) {
    if (CONTEXT_OVERFLOW.test(text)) return "context_overflow";
    if (MODEL_NOT_FOUND.test(text)) return "model_not_found";
    if (BILLING.test(text)) return "billing";
    return "bad_request";
  }
  return "unknown";
}

/**
 * Map anything a provider package throws or streams as an `error` part to a `ModelCallError`.
 * `redact` scrubs known secrets out of the message (the vault's `redact`).
 */
export function classifyError(
  err: unknown,
  redact: (text: string) => string = (t) => t,
): ModelCallError {
  if (err instanceof ModelCallError) return err;
  const vault = psycheCause(err);
  if (vault !== undefined) {
    // The vault refused the key (no grant, wrong origin, unknown item): rotate the profile.
    const kind: ModelErrorKind = vault.code === "cancelled" ? "cancelled" : "auth";
    return new ModelCallError(
      kind,
      `credential unavailable (${vault.code}): ${redact(shorten(vault.message))}`,
    );
  }
  if (APICallError.isInstance(err)) {
    const body = err.responseBody ?? "";
    const text = `${err.message} ${body}`;
    const kind =
      err.statusCode === undefined
        ? NETWORK.test(text)
          ? "network"
          : "unknown"
        : kindFromStatus(err.statusCode, text);
    const opts: { status?: number; retryAfterSec?: number } = {};
    if (err.statusCode !== undefined) opts.status = err.statusCode;
    const ra = retryAfter(err.responseHeaders);
    if (ra !== undefined) opts.retryAfterSec = ra;
    return new ModelCallError(kind, redact(shorten(err.message)), opts);
  }
  const name = err instanceof Error ? err.name : "";
  const text = textOf(err);
  if (name === "AbortError" && /timeout/i.test(text))
    return new ModelCallError("timeout", redact(shorten(text)));
  if (name === "TimeoutError") return new ModelCallError("timeout", redact(shorten(text)));
  if (name === "AbortError") return new ModelCallError("cancelled", "cancelled");
  // Streamed error parts (Anthropic `overloaded_error`, OpenAI `response.failed`, …).
  if (typeof err === "object" && err !== null) {
    const typed = err as { type?: unknown; error?: { type?: unknown; code?: unknown } };
    const t = `${String(typed.error?.type ?? typed.type ?? "")} ${String(typed.error?.code ?? "")}`;
    if (/rate_limit/i.test(t)) return new ModelCallError("rate_limited", redact(shorten(text)));
    if (/overloaded/i.test(t)) return new ModelCallError("overloaded", redact(shorten(text)));
    if (/authentication|permission/i.test(t))
      return new ModelCallError("auth", redact(shorten(text)));
    if (/api_error|server_error|internal/i.test(t))
      return new ModelCallError("server_error", redact(shorten(text)));
    if (/insufficient_quota|billing/i.test(t))
      return new ModelCallError("billing", redact(shorten(text)));
    if (/context_length|context_window/i.test(t))
      return new ModelCallError("context_overflow", redact(shorten(text)));
    if (/invalid_request/i.test(t)) {
      return new ModelCallError(
        CONTEXT_OVERFLOW.test(text) ? "context_overflow" : "bad_request",
        redact(shorten(text)),
      );
    }
  }
  if (CONTENT_FILTER.test(text) && /filter/i.test(text))
    return new ModelCallError("content_filter", redact(shorten(text)));
  if (NETWORK.test(text)) return new ModelCallError("network", redact(shorten(text)));
  if (OVERLOADED.test(text)) return new ModelCallError("overloaded", redact(shorten(text)));
  return new ModelCallError("unknown", redact(shorten(text)));
}

function psycheCause(err: unknown): PsycheError | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth += 1) {
    if (cur instanceof PsycheError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 297)}...` : oneLine;
}
