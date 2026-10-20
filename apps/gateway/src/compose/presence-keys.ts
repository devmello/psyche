import { createHash } from "node:crypto";
import { getDevice, getSetting, type PsycheDb, setSetting } from "@psyche/db";
import { type AuditLog, PsycheError } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { requireFreshPresence } from "../presence-gate.ts";
import { INTERNAL_SETTING_PREFIX } from "../state-version.ts";

/**
 * Registered helper presence keys (issue #253, security §3.7 / §12): the Secure Enclave P-256
 * key a paired Mac helper signs Touch ID answers with. The owner registers it from an admin
 * device (`devices.presenceKey.register`); the Gateway reads it from the connected helper's
 * `presence.public_key` and binds it to that device. A key counts only while its device is
 * paired and not revoked, so it is revoked with the device.
 *
 * Limit: any same-user process holding the handshake secret can pair as a helper (design-19), so
 * the owner should compare the key id with the one the genuine helper shows (`expectKeyId`)
 * until peer code signatures are checked.
 */

export const PRESENCE_KEYS_SETTING = `${INTERNAL_SETTING_PREFIX}presence.helperKeys`;

/** `PresenceKeyInfo` in the protocol. */
export interface PresenceKeyInfo {
  deviceId: string;
  keyId: string;
  registeredAt: string;
}

interface StoredKey {
  /** X9.63 uncompressed P-256 point, base64url. */
  publicKey: string;
  keyId: string;
  registeredAt: string;
}

export function presenceKeyId(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
}

export class HelperPresenceKeys {
  readonly #db: PsycheDb;

  constructor(db: PsycheDb) {
    this.#db = db;
  }

  #all(): Record<string, StoredKey> {
    const v = getSetting(this.#db, PRESENCE_KEYS_SETTING)?.value;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, StoredKey>)
      : {};
  }

  #live(deviceId: string): boolean {
    const d = getDevice(this.#db, deviceId);
    return d !== undefined && d !== null && d.pairedAt !== null && !d.revokedAt;
  }

  /** The public key that verifies `deviceId`'s answers, while the device is paired. */
  get(deviceId: string): string | undefined {
    const k = this.#all()[deviceId];
    return k !== undefined && this.#live(deviceId) ? k.publicKey : undefined;
  }

  list(): PresenceKeyInfo[] {
    return Object.entries(this.#all())
      .filter(([deviceId]) => this.#live(deviceId))
      .map(([deviceId, k]) => ({ deviceId, keyId: k.keyId, registeredAt: k.registeredAt }));
  }

  set(deviceId: string, publicKey: string, now: Date): PresenceKeyInfo {
    const stored: StoredKey = {
      publicKey,
      keyId: presenceKeyId(publicKey),
      registeredAt: now.toISOString(),
    };
    setSetting(this.#db, PRESENCE_KEYS_SETTING, { ...this.#all(), [deviceId]: stored });
    return { deviceId, keyId: stored.keyId, registeredAt: stored.registeredAt };
  }

  remove(deviceId: string): boolean {
    const all = this.#all();
    if (all[deviceId] === undefined) return false;
    const { [deviceId]: _drop, ...rest } = all;
    setSetting(this.#db, PRESENCE_KEYS_SETTING, rest);
    return true;
  }
}

/** A P-256 point in X9.63 uncompressed form: 65 bytes starting with 0x04. */
function isP256Point(b64url: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(b64url)) return false;
  const raw = Buffer.from(b64url, "base64url");
  return raw.length === 65 && raw[0] === 0x04;
}

export interface PresenceKeyDeps {
  store: HelperPresenceKeys;
  audit: Pick<AuditLog, "append">;
  /** The connected helper node of a device, if any. */
  helperNode(deviceId: string): string | undefined;
  invoke(
    nodeId: string,
    capability: string,
  ): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }>;
  now(): Date;
}

export function presenceKeyHandlers(deps: PresenceKeyDeps): Record<string, HandlerDef> {
  const audit = (kind: string, data: Record<string, string>) =>
    void deps.audit.append({ kind, actor: { type: "system" }, data }).catch(() => undefined);
  return {
    "devices.presenceKey.list": {
      run: () => ({ presenceKeys: deps.store.list() }),
    },
    "devices.presenceKey.register": {
      async run(
        call: Call,
        params: { deviceId: string; expectKeyId?: string; approvalId?: string },
      ) {
        const { deviceId } = params;
        const nodeId = deps.helperNode(deviceId);
        if (nodeId === undefined) {
          throw new PsycheError(
            "unavailable",
            "That Mac helper is not connected; open Psyche Helper on the Mac and try again",
          );
        }
        const res = await deps.invoke(nodeId, "presence.public_key");
        const out = (res.result ?? {}) as { publicKey?: unknown; keyId?: unknown };
        if (!res.ok || typeof out.publicKey !== "string" || !isP256Point(out.publicKey)) {
          throw new PsycheError(
            "unavailable",
            `The helper has no usable presence key (${res.error?.code ?? "invalid key"})`,
          );
        }
        const keyId = presenceKeyId(out.publicKey);
        if (out.keyId !== keyId) {
          throw new PsycheError("conflict", "The helper's key id does not match its key");
        }
        if (params.expectKeyId !== undefined && params.expectKeyId !== keyId) {
          throw new PsycheError(
            "conflict",
            `The helper's key id is ${keyId}, not the one you expected; nothing was registered`,
          );
        }
        // A new verifier: once presence is enrolled, adding one needs the owner's presence.
        await requireFreshPresence(
          call,
          {
            name: "method:devices.presenceKey.register",
            summary: "Register the Mac helper's Touch ID key",
            subject: { deviceId, keyId },
            details: { method: "devices.presenceKey.register", deviceId, keyId },
          },
          params.approvalId,
        );
        const presenceKey = deps.store.set(deviceId, out.publicKey, deps.now());
        audit("presence_key.registered", { deviceId, keyId });
        call.ctx.presenceState(); // records the enrollment (sticky)
        return { presenceKey };
      },
    },
    "devices.presenceKey.remove": {
      run(_call: Call, params: { deviceId: string }) {
        const removed = deps.store.remove(params.deviceId);
        if (removed) audit("presence_key.removed", { deviceId: params.deviceId });
        return { removed };
      },
    },
  };
}
