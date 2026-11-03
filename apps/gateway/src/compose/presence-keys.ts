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
 * registration requires the key id the genuine helper shows (`expectKeyId`, mandatory): on the
 * desktop main reads it from the helper bundled in the app (`psyche-helper --print-identity`),
 * never from whichever node answered on the socket, until peer code signatures are checked.
 *
 * Limit (`kind: enclave_file`): a build without a provisioning profile keeps its Secure Enclave key
 * as a wrapped blob file instead of in the keychain. Every signature still needs Touch ID inside
 * the Secure Enclave, but any same-user process can read the blob and ask for one behind its own
 * prompt and wording. Same trust boundary as the pairing limit above; Settings → Devices names
 * the kind so the owner knows which one is in use.
 */

export const PRESENCE_KEYS_SETTING = `${INTERNAL_SETTING_PREFIX}presence.helperKeys`;

/**
 * Lets a development build register its Secure Enclave file key (`kind: enclave_file`). A
 * `devices.*` security setting: changing it needs `operator.admin` and fresh presence (§10).
 */
export const DEV_FILE_KEY_SETTING = "devices.presence.allowDevFileKey";

export type PresenceKeyKind = "keychain" | "enclave_file";

/** `PresenceKeyInfo` in the protocol. */
export interface PresenceKeyInfo {
  deviceId: string;
  keyId: string;
  registeredAt: string;
  kind?: PresenceKeyKind;
}

interface StoredKey {
  /** X9.63 uncompressed P-256 point, base64url. */
  publicKey: string;
  keyId: string;
  registeredAt: string;
  kind?: PresenceKeyKind;
}

function kindOf(v: unknown): PresenceKeyKind | undefined {
  return v === "keychain" || v === "enclave_file" ? v : undefined;
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
      .map(([deviceId, k]) => ({
        deviceId,
        keyId: k.keyId,
        registeredAt: k.registeredAt,
        ...(k.kind === undefined ? {} : { kind: k.kind }),
      }));
  }

  set(deviceId: string, publicKey: string, now: Date, kind?: PresenceKeyKind): PresenceKeyInfo {
    const stored: StoredKey = {
      publicKey,
      keyId: presenceKeyId(publicKey),
      registeredAt: now.toISOString(),
      ...(kind === undefined ? {} : { kind }),
    };
    setSetting(this.#db, PRESENCE_KEYS_SETTING, { ...this.#all(), [deviceId]: stored });
    return {
      deviceId,
      keyId: stored.keyId,
      registeredAt: stored.registeredAt,
      ...(kind === undefined ? {} : { kind }),
    };
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
  /** `devices.presence.allowDevFileKey`: a development build's file key may be registered. */
  allowDevFileKey(): boolean;
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
        // The key id comes from the genuine helper, not from whatever node answers on the socket.
        if (typeof params.expectKeyId !== "string") {
          throw new PsycheError(
            "invalid_params",
            "Registering a Touch ID key needs the key id the Psyche Helper shows (expectKeyId)",
          );
        }
        const nodeId = deps.helperNode(deviceId);
        if (nodeId === undefined) {
          throw new PsycheError(
            "unavailable",
            "That Mac helper is not connected; open Psyche Helper on the Mac and try again",
          );
        }
        const res = await deps.invoke(nodeId, "presence.public_key");
        const out = (res.result ?? {}) as { publicKey?: unknown; keyId?: unknown; kind?: unknown };
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
        if (params.expectKeyId !== keyId) {
          throw new PsycheError(
            "conflict",
            `The helper's key id is ${keyId}, not the one you expected; nothing was registered`,
          );
        }
        const kind = kindOf(out.kind);
        // RELEASE BLOCKER (docs/08-roadmap.md v1.0): the development-only file key (security §10).
        if (kind === "enclave_file" && !deps.allowDevFileKey()) {
          throw new PsycheError(
            "forbidden",
            `This helper's Touch ID key is a development Secure Enclave file key; turn on ${DEV_FILE_KEY_SETTING} to register it`,
            { details: { reason: "dev_file_key_off" } },
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
        const presenceKey = deps.store.set(deviceId, out.publicKey, deps.now(), kind);
        audit("presence_key.registered", {
          deviceId,
          keyId,
          ...(kind === undefined ? {} : { kind }),
        });
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
