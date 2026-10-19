import type {
  NodeCapability,
  NodeClient,
  NodeInfo,
  NodeInvokeOptions,
  NodeInvokeResult,
  NodeReceipt,
} from "@psyche/protocol";

export interface FakeCapabilityHandler {
  capability: NodeCapability;
  /** Return the result; call `emit` to stream `node.event`s. Throwing yields `{ok:false}`. */
  handle?: (params: unknown, emit: (data: unknown) => void) => unknown | Promise<unknown>;
  receipt?: NodeReceipt;
}

/** Echo capability every fake node offers (used by the NodeClient conformance suite). */
export const FAKE_ECHO_CAPABILITY: NodeCapability = {
  name: "system.echo",
  description: "Returns its params; streams them once as an event",
  sideEffect: "none",
  streaming: true,
};

/**
 * Scripted node (mac helper, VM guest). Capabilities are registered with `handle(...)`;
 * destructive / financial capabilities require an `approvalId`; every invocation is recorded.
 */
export class FakeNodeClient implements NodeClient {
  readonly nodeId: string;
  readonly invocations: { capability: string; params: unknown; approvalId?: string }[] = [];
  #handlers = new Map<string, FakeCapabilityHandler>();
  #info: Omit<NodeInfo, "capabilities">;

  constructor(options: { nodeId?: string; kind?: NodeInfo["kind"] } = {}) {
    this.nodeId = options.nodeId ?? "node_fake";
    this.#info = {
      id: this.nodeId,
      deviceId: `dev_${this.nodeId}`,
      kind: options.kind ?? "mac-helper",
      status: "online",
      lastHeartbeatAt: null,
    };
    this.handle({
      capability: FAKE_ECHO_CAPABILITY,
      handle: (params, emit) => {
        emit(params);
        return params;
      },
    });
  }

  handle(handler: FakeCapabilityHandler): this {
    this.#handlers.set(handler.capability.name, handler);
    return this;
  }

  async info(): Promise<NodeInfo> {
    return { ...this.#info, capabilities: await this.capabilities() };
  }

  async capabilities(): Promise<NodeCapability[]> {
    return [...this.#handlers.values()].map((h) => structuredClone(h.capability));
  }

  async invoke(
    capability: string,
    params: unknown,
    options: NodeInvokeOptions = {},
  ): Promise<NodeInvokeResult> {
    if (options.signal?.aborted === true) {
      return { ok: false, error: { code: "cancelled", message: "invocation aborted" } };
    }
    const h = this.#handlers.get(capability);
    if (h === undefined) {
      return {
        ok: false,
        error: { code: "not_found", message: `unknown capability ${capability}` },
      };
    }
    const se = h.capability.sideEffect;
    if ((se === "destructive" || se === "financial") && options.approvalId === undefined) {
      return {
        ok: false,
        error: { code: "approval_required", message: `${capability} needs an approval` },
      };
    }
    const record: FakeNodeClient["invocations"][number] = {
      capability,
      params: structuredClone(params),
    };
    if (options.approvalId !== undefined) record.approvalId = options.approvalId;
    this.invocations.push(record);
    let seq = 0;
    const emit = (data: unknown) => options.onEvent?.({ seq: seq++, data });
    try {
      const result = h.handle === undefined ? null : await h.handle(params, emit);
      if (aborted(options.signal)) {
        return { ok: false, error: { code: "cancelled", message: "invocation aborted" } };
      }
      const out: NodeInvokeResult = { ok: true, result };
      if (h.receipt !== undefined) out.receipt = { ...h.receipt };
      else if (se !== "none" && se !== "read") out.receipt = { outcome: "ok", summary: capability };
      return out;
    } catch (err) {
      return {
        ok: false,
        error: { code: "internal", message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}

/** Read `aborted` through a call so TS does not keep an earlier narrowing. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
