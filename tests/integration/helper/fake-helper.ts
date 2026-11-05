import { constants, createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { helperPresenceMessage } from "@psyche/gateway/compose";
import { connectSigningPayload, PROTOCOL_VERSION } from "@psyche/protocol";

// biome-ignore lint/suspicious/noExplicitAny: wire frames in a test harness
type Json = Record<string, any>;

/**
 * A Secure Enclave stand-in (a P-256 key) or a Windows Hello one (RSA-2048), whose public half the
 * owner registers.
 */
export interface PresenceKey {
  privateKey: KeyObject;
  /**
   * base64url: the X9.63 uncompressed point (what `SecKeyCopyExternalRepresentation` returns),
   * or for RSA the SPKI DER (`KeyCredential.RetrievePublicKey`).
   */
  publicKey: string;
  algorithm?: "p256-ecdsa-sha256" | "rsa-2048-pkcs1-sha256";
}

/** A Windows Hello stand-in: RSA-2048, signatures PKCS#1 v1.5 / SHA-256 (apps/win-helper). */
export function newHelloKey(bits = 2048): PresenceKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  return {
    privateKey,
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    algorithm: "rsa-2048-pkcs1-sha256",
  };
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
  if (key.algorithm === "rsa-2048-pkcs1-sha256") {
    return sign("sha256", helperPresenceMessage(challenge), {
      key: key.privateKey,
      padding: constants.RSA_PKCS1_PADDING,
    }).toString("base64url");
  }
  return sign("sha256", helperPresenceMessage(challenge), {
    key: key.privateKey,
    dsaEncoding: "der",
  }).toString("base64url");
}

/** NDJSON lines both ways: the node socket / pipe, or the WebSocket (one frame per message). */
interface Wire {
  write(line: string): void;
  close(): Promise<void>;
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
 * What the real helper does on every connect attempt (`NodeDaemon.runOnce`): read the current
 * `run/handshake.secret` from the Gateway's home, so a Gateway restart never leaves it holding a
 * stale one. The Gateway writes the file before its sockets listen.
 */
export function readHandshakeSecret(home: string): string {
  return readFileSync(join(home, "run", "handshake.secret"), "utf8").trim();
}

/**
 * The mac helper as the Gateway sees it over the node socket (apps/mac-helper README,
 * Notifications): presents the per-launch handshake secret as `mac-helper` (only a helper that
 * does is the Host's helper; one with none, or a stale one, is denied), shows `notify.show` cards,
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
  readonly #wire: Wire;
  readonly #waiting = new Map<string, (f: Json) => void>();
  readonly #subscriptions = new Set<string>();
  readonly #subscribed: (() => void)[] = [];
  #buf = "";
  #n = 0;

  private constructor(wire: Wire, deviceId: string, presence: PresenceKey) {
    this.#wire = wire;
    this.deviceId = deviceId;
    this.presence = presence;
  }

  /** Incoming bytes from the wire (NDJSON). */
  feed(chunk: string): void {
    this.#buf += chunk;
    let i = this.#buf.indexOf("\n");
    while (i >= 0) {
      const frame = JSON.parse(this.#buf.slice(0, i)) as Json;
      this.#buf = this.#buf.slice(i + 1);
      this.#onFrame(frame);
      i = this.#buf.indexOf("\n");
    }
  }

  static async connect(
    socketPath: string,
    opts: {
      origin: string;
      /** `{ home }` reads `run/handshake.secret` as the Swift helper does; a string is sent as is; `undefined` sends none. */
      secret: string | { home: string } | undefined;
      presence?: PresenceKey;
      /** `win-helper` connects as apps/win-helper does: `platform: "windows"`. Default `mac-helper`. */
      family?: "mac-helper" | "win-helper";
      /** A `ws://…/ws` URL instead of the node socket path (where a helper is never the Host's). */
      ws?: boolean;
      /** Reuse an identity (a device paired before). */
      identity?: { privateKey: KeyObject; publicKey: string };
    },
  ): Promise<FakeHelper> {
    const secret =
      typeof opts.secret === "object" ? readHandshakeSecret(opts.secret.home) : opts.secret;
    const family = opts.family ?? "mac-helper";
    const platform = family === "win-helper" ? "windows" : "macos";
    const identity = opts.identity ?? FakeHelper.newIdentity();
    const { privateKey, publicKey } = identity;
    const deviceId = FakeHelper.deviceIdOf(publicKey);
    let helper: FakeHelper | undefined;
    let wire: Wire;
    if (opts.ws === true) {
      const ws = new WebSocket(socketPath);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
      });
      ws.addEventListener("message", (e) => helper?.feed(`${String(e.data)}\n`));
      wire = {
        write: (line) => ws.readyState === WebSocket.OPEN && ws.send(line.trimEnd()),
        close: () =>
          new Promise((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) return resolve();
            ws.addEventListener("close", () => resolve(), { once: true });
            ws.close();
          }),
      };
    } else {
      const socket = createConnection(socketPath);
      await new Promise((r) => socket.once("connect", r));
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => helper?.feed(chunk));
      wire = {
        // A named pipe (Windows) has no half-close: frames can still arrive after `end()`.
        write: (line) => void (socket.writable && socket.write(line)),
        close: () =>
          new Promise((resolve) => {
            if (socket.closed) return resolve();
            socket.once("close", () => resolve());
            socket.end();
          }),
      };
    }
    helper = new FakeHelper(wire, deviceId, opts.presence ?? newPresenceKey());
    const challenge = await helper.#request("connect", {
      protocolVersion: { min: 1, max: PROTOCOL_VERSION },
      deviceId,
      publicKey,
      role: "node",
      platform,
      deviceFamily: family,
      name: family === "win-helper" ? "Psyche (Helper)" : "Psyche Helper",
      capabilities: CAPABILITIES,
      ...(secret === undefined ? {} : { handshakeSecret: secret }),
    });
    if (challenge.ok === false) {
      await wire.close();
      throw new Error(`helper did not pair: ${JSON.stringify(challenge)}`);
    }
    const { nonce, protocolVersion } = challenge.payload;
    const signature = sign(
      null,
      connectSigningPayload({
        nonce,
        platform,
        deviceFamily: family,
        protocolVersion,
        serverOrigin: opts.origin,
      }),
      privateKey,
    ).toString("base64url");
    const verified = await helper.#request("connect.verify", { nonce, signature });
    if (verified.payload?.phase !== "paired") {
      await wire.close();
      throw new Error(`helper did not pair: ${JSON.stringify(verified)}`);
    }
    helper.nodeId = verified.payload.nodeId;
    return helper;
  }

  static newIdentity(): { privateKey: KeyObject; publicKey: string } {
    const { privateKey } = generateKeyPairSync("ed25519");
    return { privateKey, publicKey: String(privateKey.export({ format: "jwk" }).x) };
  }

  static deviceIdOf(publicKey: string): string {
    return `dev_${createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url").slice(0, 22)}`;
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
    return this.#wire.close();
  }

  #request(method: string, params: unknown): Promise<Json> {
    const id = `h${++this.#n}`;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.#wire.write(`${JSON.stringify({ type: "req", id, method, params })}\n`);
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
    this.#wire.write(
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
