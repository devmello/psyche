import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { helperPresenceMessage } from "@psyche/gateway/compose";
import { connectSigningPayload, PROTOCOL_VERSION } from "@psyche/protocol";

// biome-ignore lint/suspicious/noExplicitAny: wire frames in a test harness
type Json = Record<string, any>;

/** A Secure Enclave stand-in: a P-256 key whose public half the owner registers. */
export interface PresenceKey {
  privateKey: KeyObject;
  /** X9.63 uncompressed point, base64url (what `SecKeyCopyExternalRepresentation` returns). */
  publicKey: string;
}

export function newPresenceKey(): PresenceKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(String(jwk.x), "base64url"),
    Buffer.from(String(jwk.y), "base64url"),
  ]);
  return { privateKey, publicKey: raw.toString("base64url") };
}

export function signPresence(key: PresenceKey, challenge: string): string {
  return sign("sha256", helperPresenceMessage(challenge), {
    key: key.privateKey,
    dsaEncoding: "der",
  }).toString("base64url");
}

/** What the owner does on a banner: tap a button, then (maybe) pass Touch ID. */
export interface Tap {
  actionId: "approve" | "deny" | "default" | "dismiss";
  /** Touch ID outcome when the card asked for it (default: passes). */
  touchId?: boolean;
  /** Sign this challenge instead of the card's (an assertion made for another approval). */
  challenge?: string;
  /** Sign with this key instead of the helper's own (another device's key). */
  key?: PresenceKey;
  /** Send no signature, as the M1 helper does. */
  unsigned?: boolean;
}

const CAPABILITIES = [
  { name: "notify.show", sideEffect: "write", targetKind: "app" },
  { name: "notify.withdraw", sideEffect: "write" },
  { name: "notify.subscribe", sideEffect: "read", streaming: true },
] as const;

/**
 * The mac helper as the Gateway sees it over the node socket (apps/mac-helper README,
 * Notifications): pairs with the handshake secret as `mac-helper`, shows `notify.show` cards,
 * and streams `notify.response` events on the open `notify.subscribe`. With `requireBiometry`,
 * a non-destructive answer runs "Touch ID" first and, as the S14 issue proposes, signs the
 * card's `presenceChallenge` with its presence key.
 */
export class FakeHelper {
  readonly shown: Json[] = [];
  readonly withdrawn: string[] = [];
  readonly deviceId: string;
  readonly presence: PresenceKey;
  nodeId = "";
  readonly #socket: Socket;
  readonly #waiting = new Map<string, (f: Json) => void>();
  readonly #subscriptions = new Set<string>();
  readonly #subscribed: (() => void)[] = [];
  #buf = "";
  #n = 0;

  private constructor(socket: Socket, deviceId: string, presence: PresenceKey) {
    this.#socket = socket;
    this.deviceId = deviceId;
    this.presence = presence;
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
    opts: { origin: string; secret: string; presence?: PresenceKey },
  ): Promise<FakeHelper> {
    const socket = createConnection(socketPath);
    await new Promise((r) => socket.once("connect", r));
    const { privateKey } = generateKeyPairSync("ed25519");
    const publicKey = String(privateKey.export({ format: "jwk" }).x);
    const deviceId = `dev_${createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url").slice(0, 22)}`;
    const helper = new FakeHelper(socket, deviceId, opts.presence ?? newPresenceKey());
    const challenge = await helper.#request("connect", {
      protocolVersion: { min: 1, max: PROTOCOL_VERSION },
      deviceId,
      publicKey,
      role: "node",
      platform: "macos",
      deviceFamily: "mac-helper",
      name: "Psyche Helper",
      capabilities: CAPABILITIES,
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
      privateKey,
    ).toString("base64url");
    const verified = await helper.#request("connect.verify", { nonce, signature });
    if (verified.payload?.phase !== "paired")
      throw new Error(`helper did not pair: ${JSON.stringify(verified)}`);
    helper.nodeId = verified.payload.nodeId;
    return helper;
  }

  /** Resolves once the Gateway holds a `notify.subscribe` open. */
  subscribed(): Promise<void> {
    if (this.#subscriptions.size > 0) return Promise.resolve();
    return new Promise((r) => this.#subscribed.push(r));
  }

  /** The card shown for an approval (waits for it). */
  async card(approvalId: string, timeoutMs = 2000): Promise<Json> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const c = this.shown.find((s) => s.approvalId === approvalId);
      if (c !== undefined) return c;
      if (Date.now() > end) throw new Error(`no card for ${approvalId}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** The owner answers a shown card; emitted on every open subscription. */
  async tap(approvalId: string, tap: Tap): Promise<void> {
    const card = await this.card(approvalId);
    const destructive = (card.actions as Json[]).find((a) => a.id === tap.actionId)?.destructive;
    const needsAuth =
      card.requireBiometry === true &&
      destructive !== true &&
      tap.actionId !== "default" &&
      tap.actionId !== "dismiss";
    const authenticated = needsAuth && tap.touchId !== false;
    const challenge = tap.challenge ?? card.presenceChallenge;
    const response: Json = {
      type: "notify.response",
      notificationId: card.id,
      actionId: tap.actionId,
      approvalId: card.approvalId,
      authenticated,
      ...(needsAuth && !authenticated ? { authError: "user_cancelled" } : {}),
      ...(authenticated && tap.unsigned !== true && typeof challenge === "string"
        ? { presence: { signature: signPresence(tap.key ?? this.presence, challenge) } }
        : {}),
    };
    await Promise.all(
      [...this.#subscriptions].map((invocationId) =>
        this.#request("node.event", { invocationId, data: response }),
      ),
    );
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.#socket.closed) return resolve();
      this.#socket.once("close", () => resolve());
      this.#socket.end();
    });
  }

  #request(method: string, params: unknown): Promise<Json> {
    const id = `h${++this.#n}`;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.#socket.write(`${JSON.stringify({ type: "req", id, method, params })}\n`);
    });
  }

  #onFrame(frame: Json): void {
    if (frame.type === "res") {
      this.#waiting.get(frame.id)?.(frame);
      this.#waiting.delete(frame.id);
      return;
    }
    if (frame.type !== "req" || frame.method !== "node.invoke") return;
    const { invocationId, capability, params } = frame.params;
    this.#socket.write(
      `${JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { accepted: true } })}\n`,
    );
    if (capability === "notify.subscribe") {
      // Long-lived: no result until the Gateway cancels or the connection drops.
      this.#subscriptions.add(invocationId);
      for (const r of this.#subscribed.splice(0)) r();
      return;
    }
    if (capability === "notify.show") this.shown.push(params);
    if (capability === "notify.withdraw") this.withdrawn.push(params.id);
    void this.#request("node.result", {
      invocationId,
      ok: true,
      result: capability === "notify.show" ? { delivered: true } : {},
    });
  }
}
