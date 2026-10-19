import { sign } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { connectSigningPayload, type NodeCapability, PROTOCOL_VERSION } from "@psyche/protocol";
import { type DeviceKey, newDeviceKey } from "./helpers.ts";

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

/**
 * A node speaking the real node protocol over the Unix socket (NDJSON): pairs as the mac helper
 * with the handshake secret, declares capabilities at `connect`, answers `node.invoke` with
 * `accepted`, then sends `node.event`s and one `node.result`.
 */
export class FakeNode {
  readonly invocations: { capability: string; params: unknown; approvalId?: string }[] = [];
  nodeId = "";
  readonly #socket: Socket;
  readonly #handlers: Map<string, FakeNodeHandler>;
  readonly #waiting = new Map<string, (f: Json) => void>();
  #buf = "";
  #n = 0;

  private constructor(socket: Socket, handlers: FakeNodeHandler[]) {
    this.#socket = socket;
    this.#handlers = new Map(handlers.map((h) => [h.capability.name, h]));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buf += chunk;
      let i = this.#buf.indexOf("\n");
      while (i >= 0) {
        const frame = JSON.parse(this.#buf.slice(0, i)) as Json;
        this.#buf = this.#buf.slice(i + 1);
        this.#onFrame(frame);
        i = this.#buf.indexOf("\n");
      }
    });
  }

  static async connect(
    socketPath: string,
    opts: {
      origin: string;
      secret: string;
      handlers: FakeNodeHandler[];
      key?: DeviceKey;
      deviceId?: string;
    },
  ): Promise<FakeNode> {
    const socket = createConnection(socketPath);
    await new Promise((r) => socket.once("connect", r));
    const node = new FakeNode(socket, opts.handlers);
    const key = opts.key ?? newDeviceKey();
    const challenge = await node.request("connect", {
      protocolVersion: { min: 1, max: PROTOCOL_VERSION },
      deviceId: opts.deviceId ?? `helper-${Math.random().toString(36).slice(2)}`,
      publicKey: key.publicKey,
      role: "node",
      platform: "macos",
      deviceFamily: "mac-helper",
      name: "Psyche helper",
      capabilities: opts.handlers.map((h) => h.capability),
      handshakeSecret: opts.secret,
    });
    const { nonce, protocolVersion } = challenge.payload;
    const signature = sign(
      null,
      connectSigningPayload({
        nonce,
        platform: "macos",
        deviceFamily: "mac-helper",
        protocolVersion,
        serverOrigin: opts.origin,
      }),
      key.privateKey,
    ).toString("base64url");
    const verified = await node.request("connect.verify", { nonce, signature });
    if (verified.payload?.phase !== "paired")
      throw new Error(`node did not pair: ${JSON.stringify(verified)}`);
    node.nodeId = verified.payload.nodeId;
    return node;
  }

  request(method: string, params: unknown): Promise<Json> {
    const id = `n${++this.#n}`;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.#socket.write(`${JSON.stringify({ type: "req", id, method, params })}\n`);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.#socket.closed) return resolve();
      this.#socket.once("close", () => resolve());
      this.#socket.end();
    });
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
    this.#socket.write(
      `${JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { accepted: true } })}\n`,
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
          error: { code: "internal", message: err instanceof Error ? err.message : String(err) },
        });
      }
    })();
  }
}
