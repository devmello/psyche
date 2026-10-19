import type { ErrorPayload } from "../errors.ts";
import type { NodeCapability, NodeInfo } from "../schemas/identity.ts";

/**
 * Gateway-side view of one connected node (architecture §7; owner S01 / S14 / S19). Capabilities
 * declare side-effect classes like tools, so the Permission Broker treats `computer.click` on a
 * node like any other write. `invoke` never throws for remote failures: it resolves
 * `{ok: false, error}` (`not_found` for an unknown capability, `approval_required` for a
 * destructive / financial capability without `approvalId`, `cancelled` on abort).
 */

export interface NodeInvokeEvent {
  /** Increases by one per event within an invocation, starting at 0. */
  seq: number;
  data: unknown;
}

export interface NodeInvokeOptions {
  approvalId?: string;
  signal?: AbortSignal;
  onEvent?: (event: NodeInvokeEvent) => void;
  timeoutMs?: number;
}

export interface NodeReceipt {
  outcome: "ok" | "failed" | "uncertain";
  summary: string;
  externalRefs?: Record<string, string | number>;
}

export interface NodeInvokeResult {
  ok: boolean;
  result?: unknown;
  error?: ErrorPayload;
  receipt?: NodeReceipt;
}

export interface NodeClient {
  readonly nodeId: string;
  info(): Promise<NodeInfo>;
  capabilities(): Promise<NodeCapability[]>;
  invoke(
    capability: string,
    params: unknown,
    options?: NodeInvokeOptions,
  ): Promise<NodeInvokeResult>;
}
