import { sign } from "node:crypto";
import { createConnection } from "node:net";
import { insertDevice } from "@psyche/db";
import { connectSigningPayload, type NodeCapability, PROTOCOL_VERSION } from "@psyche/protocol";
import WebSocket from "ws";
import type { Gateway } from "../src/server.ts";
import { type DeviceKey, newDeviceKey } from "./helpers.ts";

/**
 * A node device the owner already approved (scope `node`): how a VM guest or a phone is paired
 * before it connects, since only the Host's own `mac-helper` auto-pairs with the handshake secret.
 */
export function pairNodeDevice(gateway: Gateway, deviceId: string, key: DeviceKey): void {
  insertDevice(gateway.context.db, {
    id: deviceId,
    name: "paired node",
    platform: "macos",
    role: "node",
    publicKey: key.publicKey,
    scopes: ["node"],
    pairedAt: new Date().toISOString(),
  });
}

// biome-ignore lint/suspicious/noExplicitAny: wire frames in a test harness
type Json = Record<string, any>;

export interface FakeNodeHandler {
  capability: NodeCapability;
  /** Return the result; `emit` streams `node.event`s. Throwing sends `ok: false`. */
  run?: (
    params: unknown,
    emit: (data: unknown) => void,
    approvalId?: string,
  ) => unknown | Promise<unknown>;
  /** Send a receipt with the result. */
  receipt?: { outcome: "ok" | "failed" | "uncertain"; summary: string };
  /** Accept the invocation and never answer (timeouts, disconnects). */
  hang?: boolean;
}

export interface FakeNodeOptions {
  origin: string;
  secret?: string;
  handlers: FakeNodeHandler[];
  key?: DeviceKey;
  deviceId?: string;
  /**
   * What the node declares (default `mac-helper`). Only a `mac-helper` on the Unix socket
   * auto-pairs with the handshake secret; any other family, and any WebSocket node that does not
   * present the secret, must already be a paired device (`pairNodeDevice`), as a VM guest or a
   * second Mac is once the owner approved it.
   */
  deviceFamily?: string;
}

interface Wire {
  write(frame: string): void;
  close(): Promise<void>;
}

/**
 * A node speaking the real node protocol: over the Unix socket (NDJSON, `connect`) or over the
 * WebSocket (`connectWs`, how a Mac on another machine reaches the Gateway). It pairs, declares
 * capabilities at `connect`, answers `node.invoke` with `accepted`, then sends `node.event`s and
 * one `node.result`.
 */
export class FakeNode {
  readonly invocations: { capability: string; params: unknown; approvalId?: string }[] = [];
  nodeId = "";
  readonly #wire: Wire;
  readonly #handlers: Map<string, FakeNodeHandler>;
  readonly #waiting = new Map<string, (f: Json) => void>();
  #n = 0;

  private constructor(wire: Wire, handlers: FakeNodeHandler[]) {
    this.#wire = wire;
    this.#handlers = new Map(handlers.map((h) => [h.capability.name, h]));
  }

  /** The Gateway's Unix node socket: where the Host's own Mac helper connects. */
  static async connect(socketPath: string, opts: FakeNodeOptions): Promise<FakeNode> {
    const socket = createConnection(socketPath);
    await new Promise((r) => socket.once("connect", r));
    const node = new FakeNode(
      {
        write: (frame) => void socket.write(`${frame}\n`),
        close: () =>
          new Promise((resolve) => {
            if (socket.closed) return resolve();
            socket.once("close", () => resolve());
            socket.end();
          }),
      },
      opts.handlers,
    );
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let i = buf.indexOf("\n");
      while (i >= 0) {
        const frame = JSON.parse(buf.slice(0, i)) as Json;
        buf = buf.slice(i + 1);
        node.#onFrame(frame);
        i = buf.indexOf("\n");
      }
    });
    await node.#handshake(opts);
    return node;
  }

  /**
   * A paired node that is not the Host's helper (family `psyche-node` unless told otherwise) on
   * the node socket: what `nodes.invoke` may reach, since the Host helper itself is allowlisted.
   */
  static async connectRemote(
    gateway: Gateway,
    opts: Omit<FakeNodeOptions, "origin" | "secret">,
  ): Promise<FakeNode> {
    const key = opts.key ?? newDeviceKey();
    const deviceId = opts.deviceId ?? `node-${Math.random().toString(36).slice(2)}`;
    pairNodeDevice(gateway, deviceId, key);
    return FakeNode.connect(gateway.config.nodeSocketPath, {
      ...opts,
      key,
      deviceId,
      origin: gateway.origin,
      deviceFamily: opts.deviceFamily ?? "psyche-node",
    });
  }

  /** The Gateway's WebSocket: where a node on another machine connects. */
  static async connectWs(wsUrl: string, opts: FakeNodeOptions): Promise<FakeNode> {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const node = new FakeNode(
      {
        write: (frame) => ws.send(frame),
        close: () =>
          new Promise((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) return resolve();
            ws.once("close", () => resolve());
            ws.close();
          }),
      },
      opts.handlers,
    );
    ws.on("message", (data) => node.#onFrame(JSON.parse(data.toString()) as Json));
    await node.#handshake(opts);
    return node;
  }

  async #handshake(opts: FakeNodeOptions): Promise<void> {
    const key = opts.key ?? newDeviceKey();
    const deviceFamily = opts.deviceFamily ?? "mac-helper";
    const challenge = await this.request("connect", {
      protocolVersion: { min: 1, max: PROTOCOL_VERSION },
      deviceId: opts.deviceId ?? `helper-${Math.random().toString(36).slice(2)}`,
      publicKey: key.publicKey,
      role: "node",
      platform: "macos",
      deviceFamily,
      name: "Psyche helper",
      capabilities: opts.handlers.map((h) => h.capability),
      ...(opts.secret === undefined ? {} : { handshakeSecret: opts.secret }),
    });
    const { nonce, protocolVersion } = challenge.payload;
    const signature = sign(
      null,
      connectSigningPayload({
        nonce,
        platform: "macos",
        deviceFamily,
        protocolVersion,
        serverOrigin: opts.origin,
      }),
      key.privateKey,
    ).toString("base64url");
    const verified = await this.request("connect.verify", { nonce, signature });
    if (verified.payload?.phase !== "paired")
      throw new Error(`node did not pair: ${JSON.stringify(verified)}`);
    this.nodeId = verified.payload.nodeId;
  }

  request(method: string, params: unknown): Promise<Json> {
    const id = `n${++this.#n}`;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.#wire.write(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  close(): Promise<void> {
    return this.#wire.close();
  }

  #onFrame(frame: Json): void {
    if (frame.type === "res") {
      this.#waiting.get(frame.id)?.(frame);
      this.#waiting.delete(frame.id);
      return;
    }
    if (frame.type !== "req" || frame.method !== "node.invoke") return;
    const { invocationId, capability, params, approvalId } = frame.params;
    this.invocations.push({ capability, params, ...(approvalId ? { approvalId } : {}) });
    this.#wire.write(
      JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { accepted: true } }),
    );
    const handler = this.#handlers.get(capability);
    if (handler?.hang) return;
    void (async () => {
      const emit = (data: unknown) => void this.request("node.event", { invocationId, data });
      try {
        const result = handler?.run ? await handler.run(params, emit, approvalId) : null;
        await this.request("node.result", {
          invocationId,
          ok: true,
          result,
          ...(handler?.receipt
            ? {
                receipt: {
                  id: `nr_${invocationId}`,
                  kind: capability,
                  taskId: null,
                  toolCallId: null,
                  approvalId: approvalId ?? null,
                  outcome: handler.receipt.outcome,
                  summary: handler.receipt.summary,
                  externalRefs: {},
                  payload: null,
                  createdAt: new Date().toISOString(),
                },
              }
            : {}),
        });
      } catch (err) {
        await this.request("node.result", {
          invocationId,
          ok: false,
          // A handler may throw the helper's own error shape (`code`, `details.reason`).
          error: {
            code: (err as { code?: string } | null)?.code ?? "internal",
            message: err instanceof Error ? err.message : String(err),
            ...((err as { details?: unknown } | null)?.details === undefined
              ? {}
              : { details: (err as { details: unknown }).details }),
          },
        });
      }
    })();
  }
}
