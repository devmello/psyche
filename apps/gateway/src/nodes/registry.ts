import {
  getNodeByDevice,
  getSetting,
  listNodes,
  setNodeStatus,
  setSetting,
  upsertNode,
} from "@psyche/db";
import {
  type ConnectParams,
  type ErrorPayload,
  hostHelperKindOf,
  isHostHelperFamily,
  type NodeCapability,
  type NodeClient,
  type NodeInfo,
  type NodeInvokeOptions,
  type NodeInvokeResult,
  type NodeKind,
  type NodeReceipt,
  type PeerCheck,
  PsycheError,
} from "@psyche/protocol";
import type { PairedIdentity, PeerInfo } from "../auth.ts";
import type { GatewayContext, LiveConnection } from "../context.ts";

/** Default end-to-end timeout of one invocation. */
export const NODE_INVOKE_TIMEOUT_MS = 60_000;

/**
 * The kind a node's self-declared `deviceFamily` maps to. The helper families (`mac-helper`,
 * `win-helper`, `linux-helper`) are deliberately absent: they are a claim any paired node can
 * make, so `nodeKindOf` grants them only to the Host's own helper (`PairedIdentity.hostHelper`:
 * the local node transport plus the per-launch handshake secret).
 */
const KIND_BY_FAMILY: Record<string, NodeKind> = {
  "vm-guest": "vm-guest",
  phone: "phone",
};

/**
 * `mac-helper` / `win-helper` / `host-helper` (a Linux helper) only for the Host's own helper
 * (remote-gateway design §4.1 rule 1); a claimed helper family anywhere else is `remote`. The
 * family is self-declared and proves nothing by itself: a second computer that pairs as a node,
 * or a sandbox guest whose identity file was copied, can say it too, and must never receive the
 * agent's computer use, Apple-app calls, keychain access or notifications.
 */
export function nodeKindOf(identity: PairedIdentity, params: ConnectParams): NodeKind {
  if (isHostHelperFamily(params.deviceFamily)) {
    return identity.hostHelper === true ? hostHelperKindOf(params.deviceFamily) : "remote";
  }
  return KIND_BY_FAMILY[params.deviceFamily] ?? "remote";
}

/**
 * Optional setting naming the Host helper's device id (what `psyche-helper --print-identity`
 * prints). When more than one Host helper is connected, the pinned one is used instead of
 * denying. It is under `devices.*`, so changing it needs admin and fresh presence.
 */
export const HOST_HELPER_PIN_SETTING = "devices.hostHelperDeviceId";
/**
 * Written by the Gateway: `{ ambiguous, helpers, peerCheck?, peerCheckReason?, refused? }`, so the
 * app can say why Host features are off. `peerCheck` (Linux only, additive) is what the
 * accept-time peer check found
 * for the Host helper in use: absent when there is no single helper or no check ran.
 */
export const HOST_HELPER_STATUS_SETTING = "devices.hostHelper.status";

/** The Host's Mac helper, resolved to one live node. */
export interface HostHelper {
  info: NodeInfo;
  client: NodeClient;
}

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
  readonly #live = new Map<
    string,
    {
      conn: LiveConnection;
      info: NodeInfo;
      host: boolean;
      transport: PeerInfo["transport"];
      /** The Linux accept-time peer check of this connection, when one ran (Host helper only). */
      peerCheck?: PeerCheck;
      peerCheckReason?: string;
    }
  >();
  /** Whether Host-bound routing is currently refused for want of one helper. */
  #ambiguous = false;
  /** The `peerCheck` last published in `devices.hostHelper.status`. */
  #publishedPeerCheck: string | undefined;
  readonly #invocations = new Map<string, Invocation>();

  constructor(ctx: GatewayContext) {
    this.#ctx = ctx;
    // No node is connected yet: a status left by the previous run (a crash while two helpers were
    // connected) must not survive a restart. Quiet write: nobody is subscribed at startup, and
    // later changes publish through `#syncHostHelperStatus`.
    const stored = getSetting(ctx.db, HOST_HELPER_STATUS_SETTING)?.value as
      | { ambiguous?: unknown }
      | undefined;
    if (stored !== undefined && stored.ambiguous !== false) {
      setSetting(ctx.db, HOST_HELPER_STATUS_SETTING, { ambiguous: false, helpers: 0 });
    }
  }

  attach(conn: LiveConnection, identity: PairedIdentity, params: ConnectParams): NodeInfo {
    const { db, bus } = this.#ctx;
    const existing = getNodeByDevice(db, identity.deviceId);
    const info = db.sqlite.transaction(() => {
      const node = upsertNode(db, {
        id: existing?.id ?? db.newId(),
        deviceId: identity.deviceId,
        kind: nodeKindOf(identity, params),
        capabilities: params.capabilities ?? [],
        status: "online",
      });
      bus.bumpStateVersion();
      return node;
    })();
    const previous = this.#live.get(info.id);
    // Replace before closing, so the old connection's detach does not mark the node offline.
    this.#live.set(info.id, {
      conn,
      info,
      host: identity.hostHelper === true,
      transport: conn.peer.transport,
      // Only a Host helper carries one, and only the checker sets it on the peer, never the peer.
      ...(identity.hostHelper === true && conn.peer.peerCheck !== undefined
        ? {
            peerCheck: conn.peer.peerCheck,
            ...(conn.peer.peerCheckReason === undefined
              ? {}
              : { peerCheckReason: conn.peer.peerCheckReason }),
          }
        : {}),
    });
    if (previous && previous.conn !== conn) {
      this.#failInvocations(previous.conn.id, "replaced by a new connection");
      previous.conn.close("replaced by a new connection");
    }
    bus.publish("node.updated", { node: info });
    this.#syncHostHelperStatus();
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
    this.#syncHostHelperStatus();
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

  #liveHostHelpers(): {
    conn: LiveConnection;
    info: NodeInfo;
    peerCheck?: PeerCheck;
    peerCheckReason?: string;
  }[] {
    return [...this.#live.values()].filter((e) => e.host);
  }

  /** The pinned Host helper's device id (`HOST_HELPER_PIN_SETTING`), when one is set. */
  #pinnedDevice(): string | undefined {
    const v = getSetting(this.#ctx.db, HOST_HELPER_PIN_SETTING)?.value;
    return typeof v === "string" && v !== "" ? v : undefined;
  }

  /**
   * The one live Host helper to use, or `undefined` for none or an ambiguous Host. With several,
   * the pinned device wins when it is among them; otherwise nothing is chosen.
   */
  #soleHostHelper():
    | { conn: LiveConnection; info: NodeInfo; peerCheck?: PeerCheck; peerCheckReason?: string }
    | undefined {
    const live = this.#liveHostHelpers();
    if (live.length <= 1) return live[0];
    const pin = this.#pinnedDevice();
    return pin === undefined ? undefined : live.find((e) => e.info.deviceId === pin);
  }

  /**
   * The Host's helper, for everything that acts on the Host's own computer: computer use, the
   * Apple apps, Messages, the keychain, Host notifications, Host speech, OCR, the on-device
   * model and the sandbox Mac (remote-gateway design §4.1). Never "the newest node that offers
   * `capability`": only a `mac-helper` or `win-helper` on the Gateway's local node transport
   * (Unix socket, or the named pipe on Windows) that proved the per-launch handshake secret
   * qualifies, so a computer paired over the network, or a sandbox guest, is never a candidate,
   * however recently it connected. The Windows helper offers no Apple-app capabilities, so a
   * `capability` filter for one of those finds nothing on Windows.
   *
   * Deny by default: with more than one live Host helper the answer is `undefined`, never a
   * guess, unless the owner pinned one (`devices.hostHelperDeviceId`) and it is connected. The
   * ambiguity is reported in `devices.hostHelper.status`. `capability` narrows the result: the
   * chosen helper must offer it, else `undefined`.
   */
  hostHelper(capability?: string): HostHelper | undefined {
    const chosen = this.#soleHostHelper();
    if (chosen === undefined) return undefined;
    if (capability !== undefined && !chosen.info.capabilities.some((c) => c.name === capability)) {
      return undefined;
    }
    return this.#hostHelperOf(chosen);
  }

  /**
   * Publishes whether Host-bound features are off because more than one helper is connected, on
   * change only: the app can read `devices.hostHelper.status` and say so (UI follows).
   */
  #syncHostHelperStatus(): void {
    const live = this.#liveHostHelpers();
    const sole = this.#soleHostHelper();
    const ambiguous = live.length > 1 && sole === undefined;
    const peerCheck = sole?.peerCheck;
    const peerCheckReason = sole?.peerCheckReason;
    const publishedKey = `${peerCheck ?? ""}:${peerCheckReason ?? ""}`;
    if (ambiguous === this.#ambiguous && publishedKey === this.#publishedPeerCheck) return;
    const ambiguityChanged = ambiguous !== this.#ambiguous;
    this.#ambiguous = ambiguous;
    this.#publishedPeerCheck = publishedKey;
    if (ambiguous && ambiguityChanged) {
      this.#ctx.log.log("warn", "host helper ambiguous: more than one helper on the node socket", {
        helpers: live.length,
      });
    }
    const entry = setSetting(this.#ctx.db, HOST_HELPER_STATUS_SETTING, {
      ambiguous,
      helpers: live.length,
      ...(peerCheck === undefined ? {} : { peerCheck }),
      ...(peerCheckReason === undefined ? {} : { peerCheckReason }),
    });
    this.#ctx.bus.bumpStateVersion();
    this.#ctx.bus.publish("settings.changed", { entries: [entry] });
  }

  /**
   * The Host helper of one device, for callers that pin it (Touch ID: the helper the desktop
   * launched from its own bundle). A pin settles the ambiguity `hostHelper` refuses, and a node
   * of another device, or one that is not the Host's helper, never matches.
   */
  hostHelperOfDevice(deviceId: string): HostHelper | undefined {
    const entry = this.#liveHostHelpers().find((e) => e.info.deviceId === deviceId);
    return entry === undefined ? undefined : this.#hostHelperOf(entry);
  }

  /** Every live Host helper (zero, one, or more than one: the caller decides what that means). */
  hostHelpers(): HostHelper[] {
    return this.#liveHostHelpers().map((e) => this.#hostHelperOf(e));
  }

  /** The transport a live node arrived on (`vm-relay` for a relayed sandbox guest). */
  transportOf(nodeId: string): PeerInfo["transport"] | undefined {
    return this.#live.get(nodeId)?.transport;
  }

  /** Whether `nodeId` is a live Host helper. */
  isHostHelper(nodeId: string): boolean {
    return this.#live.get(nodeId)?.host === true;
  }

  #hostHelperOf(entry: { conn: LiveConnection; info: NodeInfo }): HostHelper {
    return {
      info: structuredClone(entry.info),
      client: new ConnectionNodeClient(this, entry.conn, entry.info),
    };
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

/**
 * Writes why the Linux helper was turned away into `devices.hostHelper.status` (`refused`), so
 * Settings can say "the installed helper could not be verified" instead of the helper just not
 * connecting. A quiet write (no event): the next change the registry publishes replaces the whole
 * value, which also clears a refusal that no longer applies.
 */
export function recordPeerRefusal(
  db: GatewayContext["db"],
  refusal: { peerCheck: PeerCheck; reason: string; required: boolean; message: string },
): void {
  const current = getSetting(db, HOST_HELPER_STATUS_SETTING)?.value;
  const base =
    typeof current === "object" && current !== null && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : { ambiguous: false, helpers: 0 };
  setSetting(db, HOST_HELPER_STATUS_SETTING, {
    ...base,
    refused: { ...refusal, at: new Date().toISOString() },
  });
}
