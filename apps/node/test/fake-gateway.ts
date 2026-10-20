import { createPublicKey, randomBytes, verify } from "node:crypto";
import {
  type ConnectParams,
  connectSigningPayload,
  type DeviceScope,
  errRes,
  type NodeResultParams,
  okRes,
  PROTOCOL_VERSION,
  PsycheError,
  parseFrame,
  reqFrame,
  serializeFrame,
  validateParams,
} from "@psyche/protocol";
import { ChannelEvents, type FrameChannel } from "../src/transports/channel.ts";

/** Two connected in-memory channels; delivery is async like a real socket. */
export function channelPair(): [FrameChannel, FrameChannel] {
  const a = new ChannelEvents();
  const b = new ChannelEvents();
  const make = (self: ChannelEvents, other: ChannelEvents, describe: string): FrameChannel => ({
    describe,
    send(frame) {
      if (self.closed) return;
      setImmediate(() => other.emitFrame(frame));
    },
    onFrame: (l) => self.onFrame(l),
    onClose: (l) => self.onClose(l),
    close(reason = "closed") {
      if (self.closed) return;
      self.emitClose(reason);
      setImmediate(() => other.emitClose(reason));
    },
  });
  return [make(a, b, "memory:node"), make(b, a, "memory:gateway")];
}

export type Decision =
  | { phase: "paired"; scopes?: DeviceScope[] }
  | { phase: "pending"; code?: string }
  | { phase: "denied"; reason: string };

export interface InvokeRecord {
  invocationId: string;
  events: unknown[];
  result: Promise<NodeResultParams>;
}

/**
 * A Gateway stand-in that speaks the real handshake (Ed25519 verify over
 * `connectSigningPayload`) and the node methods, enough to drive `NodeAgent` end to end.
 */
export class FakeGateway {
  readonly serverOrigin = "http://127.0.0.1:7979";
  /** What `connect.verify` answers; may be a function of the attempt number. */
  decide: (attempt: number, params: ConnectParams) => Decision = () => ({ phase: "paired" });
  serverTime: () => Date = () => new Date();
  readonly connects: ConnectParams[] = [];
  readonly connections: FrameChannel[] = [];
  readonly results = new Map<string, NodeResultParams>();
  readonly events = new Map<string, unknown[]>();
  #waiters = new Map<string, (r: NodeResultParams) => void>();
  #pending = new Map<
    string,
    (frame: { ok: boolean; payload?: unknown; error?: unknown }) => void
  >();
  #current: FrameChannel | null = null;
  #nextId = 0;
  #onPaired: (() => void)[] = [];
  /** Refuse connections (simulates a Gateway that is down). */
  down = false;

  /** A `ChannelFactory` for the agent: each call is a fresh connection. */
  readonly connect = async (): Promise<FrameChannel> => {
    if (this.down) throw new Error("ECONNREFUSED");
    const [node, gw] = channelPair();
    this.#serve(gw);
    return node;
  };

  get current(): FrameChannel | null {
    return this.#current;
  }

  /** Resolves on the next successful pairing. */
  nextPaired(): Promise<void> {
    return new Promise((resolve) => this.#onPaired.push(resolve));
  }

  #serve(ch: FrameChannel): void {
    this.connections.push(ch);
    let params: ConnectParams | null = null;
    let nonce = "";
    let paired = false;
    ch.onClose(() => {
      if (this.#current === ch) this.#current = null;
    });
    ch.onFrame((raw) => {
      const frame = parseFrame(raw);
      if (frame.type === "res") {
        this.#pending.get(frame.id)?.(frame);
        this.#pending.delete(frame.id);
        return;
      }
      if (frame.type !== "req") return;
      const reply = (payload: unknown) => ch.send(serializeFrame(okRes(frame.id, payload)));
      const fail = (e: PsycheError) => ch.send(serializeFrame(errRes(frame.id, e)));
      try {
        if (frame.method === "connect") {
          params = validateParams("connect", frame.params) as ConnectParams;
          this.connects.push(params);
          nonce = randomBytes(32).toString("base64url");
          reply({
            phase: "challenge",
            nonce,
            serverOrigin: this.serverOrigin,
            protocolVersion: PROTOCOL_VERSION,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
          return;
        }
        if (frame.method === "connect.verify") {
          const v = validateParams("connect.verify", frame.params) as {
            nonce: string;
            signature: string;
          };
          if (!params || v.nonce !== nonce) throw new PsycheError("unauthorized", "bad nonce");
          const key = createPublicKey({
            key: { kty: "OKP", crv: "Ed25519", x: params.publicKey },
            format: "jwk",
          });
          const payload = connectSigningPayload({
            nonce,
            platform: params.platform,
            deviceFamily: params.deviceFamily,
            protocolVersion: PROTOCOL_VERSION,
            serverOrigin: this.serverOrigin,
          });
          if (!verify(null, payload, key, Buffer.from(v.signature, "base64url"))) {
            throw new PsycheError("unauthorized", "Bad challenge signature");
          }
          const decision = this.decide(this.connects.length, params);
          if (decision.phase === "paired") {
            paired = true;
            this.#current = ch;
            reply({
              phase: "paired",
              deviceId: params.deviceId,
              scopes: decision.scopes ?? ["node"],
              nodeId: "node_1",
              stateVersion: 0,
              serverTime: this.serverTime().toISOString(),
            });
            const listeners = this.#onPaired.splice(0);
            setImmediate(() => {
              for (const l of listeners) l();
            });
          } else if (decision.phase === "pending") {
            reply({
              phase: "pending",
              pairingRequestId: "pr_1",
              code: decision.code ?? "ABCD-EFGH",
            });
          } else {
            reply(decision);
            setImmediate(() => ch.close("denied"));
          }
          return;
        }
        if (!paired) throw new PsycheError("not_paired", "not paired");
        if (frame.method === "node.event") {
          const p = validateParams("node.event", frame.params) as {
            invocationId: string;
            data: unknown;
          };
          const list = this.events.get(p.invocationId) ?? [];
          list.push(p.data);
          this.events.set(p.invocationId, list);
          reply({ ok: true });
          return;
        }
        if (frame.method === "node.result") {
          const p = validateParams("node.result", frame.params) as NodeResultParams;
          this.results.set(p.invocationId, p);
          this.#waiters.get(p.invocationId)?.(p);
          reply({ ok: true });
          return;
        }
        throw new PsycheError("unknown_method", frame.method);
      } catch (err) {
        fail(PsycheError.from(err));
      }
    });
  }

  /** Sends a request to the paired node and resolves its `res`. */
  request(
    method: string,
    params: unknown,
  ): Promise<{ ok: boolean; payload?: unknown; error?: unknown }> {
    const ch = this.#current;
    if (!ch) throw new Error("no paired node");
    const id = `g${this.#nextId++}`;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      ch.send(serializeFrame(reqFrame(id, method, params)));
    });
  }

  /** `node.invoke`; resolves the accept `res` and a promise for the final `node.result`. */
  async invoke(
    capability: string,
    params: unknown,
    approvalId?: string,
  ): Promise<{
    accepted: { ok: boolean; payload?: unknown; error?: unknown };
    result: Promise<NodeResultParams>;
    invocationId: string;
  }> {
    const invocationId = `inv_${this.#nextId++}`;
    const result = new Promise<NodeResultParams>((resolve) =>
      this.#waiters.set(invocationId, resolve),
    );
    const accepted = await this.request("node.invoke", {
      invocationId,
      capability,
      params,
      ...(approvalId ? { approvalId } : {}),
    });
    return { accepted, result, invocationId };
  }

  /** Drops the paired connection (Gateway restart, network loss, approval). */
  drop(reason = "gateway restarted"): void {
    this.#current?.close(reason);
  }
}
