import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ComposedGateway, type ComposeOptions, composeGateway } from "@psyche/gateway/compose";
import { PROTOCOL_VERSION } from "@psyche/protocol";
import { GatewayConnection, type GatewayEvent, type GatewayStatus } from "@psyche/web/client";

/**
 * The walking skeleton's test rig: a composed `psyched` (real packages) in a temporary
 * `$PSYCHE_HOME`, and the desktop's own Gateway client (`@psyche/web/client`) paired over
 * loopback with the handshake secret, exactly as `apps/desktop` connects.
 */

const silent = { log: () => {} };

export interface Skeleton {
  composed: ComposedGateway;
  home: string;
  /** A folder the owner granted read-write. */
  granted: string;
  client: Client;
  /** The desktop's device id (the same key across relaunches). */
  deviceId: string;
  /** A new connection with the same device key: the desktop after a relaunch. */
  connect(): Promise<Client>;
  stop(): Promise<void>;
}

export class Client {
  readonly events: GatewayEvent[] = [];
  readonly #conn: GatewayConnection;
  readonly #waiters = new Set<() => void>();
  status: GatewayStatus | null = null;
  #idem = 0;

  constructor(
    conn: (
      onStatus: (s: GatewayStatus) => void,
      onEvent: (e: GatewayEvent) => void,
    ) => GatewayConnection,
  ) {
    this.#conn = conn(
      (s) => {
        this.status = s;
        this.#poke();
      },
      (e) => {
        this.events.push(e);
        this.#poke();
      },
    );
  }

  #poke(): void {
    for (const w of this.#waiters) w();
  }

  start(): void {
    this.#conn.start();
  }

  stop(): void {
    this.#conn.stop();
  }

  call<T = Record<string, unknown>>(
    method: string,
    params: unknown = {},
    sideEffecting = false,
  ): Promise<T> {
    const options = sideEffecting ? { idempotencyKey: `ik_${Date.now()}_${++this.#idem}` } : {};
    return this.#conn.call(method, params, options) as Promise<T>;
  }

  /** Resolves once `pred` holds, re-checked on every status change and event. */
  until<T>(pred: () => T | undefined | false, label: string, timeoutMs = 10_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const v = pred();
        if (v !== undefined && v !== false) {
          this.#waiters.delete(check);
          clearTimeout(timer);
          resolve(v);
        }
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(check);
        reject(
          new Error(
            `timed out waiting for ${label}; events: ${this.events.map((e) => e.event).join(", ")}`,
          ),
        );
      }, timeoutMs);
      this.#waiters.add(check);
      check();
    });
  }

  /** The first event named `name` after index `from` that matches `pred`. */
  event<P = Record<string, unknown>>(
    name: string,
    pred: (payload: P) => boolean = () => true,
    from = 0,
    timeoutMs?: number,
  ): Promise<P> {
    return this.until(
      () =>
        this.events.slice(from).find((e) => e.event === name && pred(e.payload as P))?.payload as
          | P
          | undefined,
      name,
      timeoutMs,
    );
  }

  get mark(): number {
    return this.events.length;
  }
}

function deviceKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const publicKey = String(jwk.x);
  const deviceId = `dev_${createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url").slice(0, 22)}`;
  return { deviceId, publicKey, privateKey };
}

export async function startSkeleton(
  options: Pick<
    ComposeOptions,
    "model" | "clock" | "timeZone" | "taskPollMs" | "compaction" | "parts"
  > & {
    readOnly?: string[];
  },
): Promise<Skeleton> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "psyche-int1-")));
  // The owner's folder lives outside $PSYCHE_HOME: tools never reach Psyche's own files (#285).
  const granted = realpathSync(mkdtempSync(join(tmpdir(), "psyche-int1-granted-")));
  const composed = await composeGateway({
    ...options,
    env: {},
    logger: silent,
    retentionIntervalMs: 0,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    policy: { folders: [{ path: granted, mode: "rw" }] },
  });
  const { gateway } = composed;
  const key = deviceKey();
  const clients: Client[] = [];
  const connect = async () => {
    const client = newClient();
    clients.push(client);
    client.start();
    await client.until(() => client.status?.phase === "paired", "pairing");
    return client;
  };
  const newClient = () =>
    new Client(
      (onStatus, onEvent) =>
        new GatewayConnection({
          wsUrl: `ws://127.0.0.1:${gateway.port}/ws`,
          healthUrl: `${gateway.origin}/healthz`,
          connectParams: () => ({
            protocolVersion: { min: 1, max: PROTOCOL_VERSION },
            deviceId: key.deviceId,
            publicKey: key.publicKey,
            role: "client",
            platform: "macos",
            deviceFamily: "desktop",
            name: "INT-1 desktop",
            handshakeSecret: gateway.handshakeSecret,
          }),
          sign: (payload) => sign(null, payload, key.privateKey).toString("base64url"),
          onStatus,
          onEvent,
        }),
    );
  const client = await connect();
  return {
    composed,
    home,
    granted,
    client,
    deviceId: key.deviceId,
    connect,
    async stop() {
      for (const c of clients) c.stop();
      await composed.stop("test");
      rmSync(home, { recursive: true, force: true });
      rmSync(granted, { recursive: true, force: true });
    },
  };
}
