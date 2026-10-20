import type { ErrorPayload, NodeCapability, Receipt } from "@psyche/protocol";
import type { SkewClock } from "../clock.ts";

/**
 * A capability provider: detects whether it can run on this machine, declares its manifest
 * entries (side effects exactly like tools, architecture §7) and runs invocations.
 *
 * Handlers never see the Gateway connection. They get an `InvocationContext` to stream progress
 * and to build receipts, and return a `CapabilityOutcome`; the agent turns that into exactly
 * one `node.result`.
 */
export interface InvocationContext {
  readonly invocationId: string;
  readonly capability: string;
  /** Set when the Gateway's Permission Broker required an approval; passed through untouched. */
  readonly approvalId: string | undefined;
  /** Aborted when the Gateway connection drops, the node shuts down, or `node.cancel` arrives. */
  readonly signal: AbortSignal;
  /** Gateway-aligned clock (skew corrected), for receipts and deadlines. */
  readonly clock: SkewClock;
  /** Streams one `node.event { invocationId, data }`. Ignored after the result is sent. */
  emit(data: unknown): void;
  /** Builds a protocol `Receipt` stamped with the Gateway-aligned clock and this approvalId. */
  receipt(input: ReceiptInput): Receipt;
}

export interface ReceiptInput {
  kind: string;
  outcome: Receipt["outcome"];
  summary: string;
  externalRefs?: Record<string, string | number>;
  payload?: Record<string, unknown> | null;
}

export type CapabilityOutcome =
  | { ok: true; result?: unknown; receipt?: Receipt }
  | { ok: false; error: ErrorPayload; receipt?: Receipt };

export type CapabilityHandler = (
  params: unknown,
  ctx: InvocationContext,
) => Promise<CapabilityOutcome>;

export interface CapabilityEntry {
  manifest: NodeCapability;
  handler: CapabilityHandler;
}

export interface CapabilityProvider {
  /** Short id for logs and `health` (e.g. "exec", "fs", "browser", "helper"). */
  readonly id: string;
  /**
   * What this provider offers right now; empty when unavailable. Called at start-up and again
   * before every (re)connect, so availability changes (a helper launching) are picked up.
   */
  entries(): Promise<CapabilityEntry[]>;
  /** One-line status for `health` (no secrets, no paths outside the node's own home). */
  status?(): Promise<Record<string, unknown>>;
  /** Fires when `entries()` would return a different set (the agent re-declares). */
  onChange?(listener: () => void): void;
  dispose?(): Promise<void>;
}

/** Convenience for handlers: an error outcome. */
export function fail(
  code: ErrorPayload["code"],
  message: string,
  extra: { details?: Record<string, unknown>; retryable?: boolean; receipt?: Receipt } = {},
): CapabilityOutcome {
  const error: ErrorPayload = { code, message };
  if (extra.details) error.details = extra.details;
  if (extra.retryable !== undefined) error.retryable = extra.retryable;
  return extra.receipt ? { ok: false, error, receipt: extra.receipt } : { ok: false, error };
}
