import { getNodeByDevice, listNodes, setNodeStatus, upsertNode } from "@psyche/db";
import {
  type ConnectParams,
  type ErrorPayload,
  type NodeCapability,
  type NodeClient,
  type NodeInfo,
  type NodeInvokeOptions,
  type NodeInvokeResult,
  type NodeKind,
  type NodeReceipt,
  PsycheError,
} from "@psyche/protocol";
import type { PairedIdentity } from "../auth.ts";
import type { GatewayContext, LiveConnection } from "../context.ts";

/** Default end-to-end timeout of one invocation. */
export const NODE_INVOKE_TIMEOUT_MS = 60_000;

const KIND_BY_FAMILY: Record<string, NodeKind> = {
  "mac-helper": "mac-helper",
  "vm-guest": "vm-guest",
  phone: "phone",
};

interface Invocation {
  connId: string;
  onEvent?: NodeInvokeOptions["onEvent"];
  seq: number;
  resolve(result: NodeInvokeResult): void;
}

/**
 * Node registry (architecture §7). A connection paired with role `node` registers here with the
 * capabilities it declared at `connect`; the registry persists the `nodes` row, exposes each
 * live node as a `NodeClient` (for `nodes.invoke` and, later, the agent's node tools) and routes
 * `node.event` / `node.result` back to the waiting invocation.
 */
export class NodeRegistry {
  readonly #ctx: GatewayContext;
  readonly #live = new Map<string, { conn: LiveConnection; info: NodeInfo }>();
  readonly #invocations = new Map<string, Invocation>();

  constructor(ctx: GatewayContext) {
    this.#ctx = ctx;
  }

  attach(conn: LiveConnection, identity: PairedIdentity, params: ConnectParams): NodeInfo {
    const { db, bus } = this.#ctx;
    const existing = getNodeByDevice(db, identity.deviceId);
    const info = db.sqlite.transaction(() => {
      const node = upsertNode(db, {
        id: existing?.id ?? db.newId(),
        deviceId: identity.deviceId,
        kind: KIND_BY_FAMILY[params.deviceFamily] ?? "remote",
        capabilities: params.capabilities ?? [],
        status: "online",
      });
      bus.bumpStateVersion();
      return node;
    })();
    const previous = this.#live.get(info.id);
    // Replace before closing, so the old connection's detach does not mark the node offline.
    this.#live.set(info.id, { conn, info });
    if (previous && previous.conn !== conn) {
      this.#failInvocations(previous.conn.id, "replaced by a new connection");
      previous.conn.close("replaced by a new connection");
    }
    bus.publish("node.updated", { node: info });
    return info;
  }

  detach(conn: LiveConnection): void {
    for (const [nodeId, entry] of this.#live) {
      if (entry.conn !== conn) continue;
      this.#live.delete(nodeId);
      this.#failInvocations(conn.id, "node disconnected");
      const node = setNodeStatus(this.#ctx.db, nodeId, "offline");
      if (node) this.#ctx.bus.publish("node.updated", { node });
    }
  }

  #failInvocations(connId: string, message: string): void {
    for (const [id, inv] of this.#invocations) {
      if (inv.connId === connId) {
        this.#invocations.delete(id);
        inv.resolve({ ok: false, error: { code: "unavailable", message } });
      }
    }
  }

  list(): NodeInfo[] {
    return listNodes(this.#ctx.db);
  }

  client(nodeId: string): NodeClient | undefined {
    const entry = this.#live.get(nodeId);
    if (!entry) return undefined;
    return new ConnectionNodeClient(this, entry.conn, entry.info);
  }

  isLive(nodeId: string): boolean {
    return this.#live.has(nodeId);
  }

  /** `node.event` from the node that owns the invocation. */
  onEvent(conn: LiveConnection, invocationId: string, data: unknown): void {
    const inv = this.#invocations.get(invocationId);
    if (!inv || inv.connId !== conn.id) throw new PsycheError("not_found", "unknown invocation");
    inv.onEvent?.({ seq: inv.seq++, data });
  }

  /** `node.result` from the node that owns the invocation. */
  onResult(
    conn: LiveConnection,
    invocationId: string,
    result: {
      ok: boolean;
      result?: unknown;
      error?: ErrorPayload;
      receipt?: {
        outcome: string;
        summary: string;
        externalRefs?: Record<string, string | number>;
      };
    },
  ): void {
    const inv = this.#invocations.get(invocationId);
    if (!inv || inv.connId !== conn.id) throw new PsycheError("not_found", "unknown invocation");
    this.#invocations.delete(invocationId);
    const out: NodeInvokeResult = { ok: result.ok };
    if (result.result !== undefined) out.result = result.result;
    if (result.error !== undefined) out.error = result.error;
    if (result.receipt !== undefined) {
      const outcome = result.receipt.outcome;
      const receipt: NodeReceipt = {
        outcome: outcome === "ok" || outcome === "failed" ? outcome : "uncertain",
        summary: result.receipt.summary,
      };
      if (result.receipt.externalRefs) receipt.externalRefs = result.receipt.externalRefs;
      out.receipt = receipt;
    }
    inv.resolve(out);
  }

  /** Sends `node.invoke` and waits for `node.result`. Never throws for remote failures. */
  invoke(
    conn: LiveConnection,
    capability: string,
    params: unknown,
    options: NodeInvokeOptions = {},
  ): Promise<NodeInvokeResult> {
    const invocationId = this.#ctx.db.newId();
    return new Promise<NodeInvokeResult>((resolve) => {
      let settled = false;
      const finish = (r: NodeInvokeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.#invocations.delete(invocationId);
        resolve(r);
      };
      const onAbort = () =>
        finish({ ok: false, error: { code: "cancelled", message: "invocation aborted" } });
      const timer = setTimeout(
        () => finish({ ok: false, error: { code: "timeout", message: `${capability} timed out` } }),
        options.timeoutMs ?? NODE_INVOKE_TIMEOUT_MS,
      );
      timer.unref();
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#invocations.set(invocationId, {
        connId: conn.id,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        seq: 0,
        resolve: finish,
      });
      conn
        .request("node.invoke", {
          invocationId,
          capability,
          params,
          ...(options.approvalId ? { approvalId: options.approvalId } : {}),
        })
        .catch((err) => finish({ ok: false, error: PsycheError.from(err).toPayload() }));
    });
  }
}

/** `NodeClient` over a live node connection. */
class ConnectionNodeClient implements NodeClient {
  readonly nodeId: string;
  readonly #registry: NodeRegistry;
  readonly #conn: LiveConnection;
  readonly #info: NodeInfo;

  constructor(registry: NodeRegistry, conn: LiveConnection, info: NodeInfo) {
    this.nodeId = info.id;
    this.#registry = registry;
    this.#conn = conn;
    this.#info = info;
  }

  async info(): Promise<NodeInfo> {
    return structuredClone(this.#info);
  }

  async capabilities(): Promise<NodeCapability[]> {
    return structuredClone(this.#info.capabilities);
  }

  async invoke(
    capability: string,
    params: unknown,
    options: NodeInvokeOptions = {},
  ): Promise<NodeInvokeResult> {
    if (!this.#info.capabilities.some((c) => c.name === capability)) {
      return {
        ok: false,
        error: { code: "not_found", message: `unknown capability ${capability}` },
      };
    }
    return this.#registry.invoke(this.#conn, capability, params, options);
  }
}
