import { constants, createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import {
  getDevice,
  getDeviceFamily,
  getSetting,
  listDevices,
  type PsycheDb,
  setSetting,
} from "@psyche/db";
import { type AuditLog, PsycheError } from "@psyche/protocol";
import { hostWords } from "@psyche/protocol/host-words";
import type { Call, HandlerDef } from "../context.ts";
import { requireFreshPresence } from "../presence-gate.ts";
import { INTERNAL_SETTING_PREFIX } from "../state-version.ts";

/**
 * The keys that verify a helper's presence answers (security §3.7, §12).
 *
 * - **mac-helper: no key to register.** The Mac helper shows the system's own owner sheet
 *   (LocalAuthentication, Touch ID or the Mac login password) and then signs the Gateway's
 *   challenge with its Ed25519 device identity key, the one this Gateway pinned when the owner
 *   approved the helper's pairing. So the verifying key is the device's own `publicKey`
 *   (`HelperPresenceKeys.get`), with nothing to set up, nothing to keep in the keychain and
 *   nothing that can go stale. It is revoked with the device. The signature proves the genuine
 *   helper answered; the sheet is the proof that someone sat at the Mac. Limit: a process running
 *   as the owner can read that key file and sign for the helper, or drive the helper into showing
 *   the sheet; see security §3.7 and §10.
 * - **win-helper: a registered Windows Hello key** (`devices.presenceKey.register`): the TPM-backed
 *   RSA key of the helper's `KeyCredential`, registered by the owner from an admin device. A key
 *   counts only while its device is paired and not revoked.
 *
 * Any same-user process holding the handshake secret can pair as a helper (design-19), so
 * registering a Windows Hello key requires the key id the genuine helper shows (`expectKeyId`,
 * mandatory): on the desktop main reads it from the helper bundled in the app, never from whichever
 * node answered on the socket.
 */

export const PRESENCE_KEYS_SETTING = `${INTERNAL_SETTING_PREFIX}presence.helperKeys`;

/**
 * What `devices.presenceKey.remove` forgot, per device: Remove needs no presence (narrowing calls
 * stay admin-only), so without this record a Remove followed by a Register would hide that a
 * different key replaced the old one.
 */
export const PRESENCE_REMOVED_SETTING = `${INTERNAL_SETTING_PREFIX}presence.helperKeysRemoved`;

interface RemovedKey {
  previousKeyId: string;
  previousKind?: PresenceKeyKind;
  removedAt: string;
}

export type PresenceKeyKind = "device_identity" | "windows_hello";

/** `PresenceKeyInfo` in the protocol. */
export interface PresenceKeyInfo {
  deviceId: string;
  keyId: string;
  registeredAt: string;
  kind?: PresenceKeyKind;
  algorithm?: PresenceKeyAlgorithm;
}

interface StoredKey {
  /** SPKI DER of an RSA key (Windows Hello); base64url. */
  publicKey: string;
  keyId: string;
  registeredAt: string;
  kind?: PresenceKeyKind;
  algorithm?: PresenceKeyAlgorithm;
}

function kindOf(v: unknown): PresenceKeyKind | undefined {
  return v === "windows_hello" ? v : undefined;
}

/** The `deviceFamily` the Mac helper pins when it pairs. */
export const MAC_HELPER_FAMILY = "mac-helper";

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

  /**
   * The Mac helper's own device key (Ed25519, as the Gateway pinned it at pairing) while its device
   * is paired: the key its owner-sheet answers verify against. Undefined for any other device.
   */
  #deviceKey(deviceId: string): string | undefined {
    const d = getDevice(this.#db, deviceId);
    return d !== undefined &&
      d.pairedAt !== null &&
      !d.revokedAt &&
      getDeviceFamily(this.#db, deviceId) === MAC_HELPER_FAMILY
      ? d.publicKey
      : undefined;
  }

  /** The key the owner registered for `deviceId` (a Windows Hello key), while it is paired. */
  registered(deviceId: string): string | undefined {
    const k = this.#all()[deviceId];
    return k !== undefined && this.#live(deviceId) ? k.publicKey : undefined;
  }

  /** Whether `deviceId`'s verifying key is the Mac helper's own device key (nothing registered). */
  isDeviceKey(deviceId: string): boolean {
    return this.#deviceKey(deviceId) !== undefined;
  }

  /** The public key that verifies `deviceId`'s answers, while the device is paired. */
  get(deviceId: string): string | undefined {
    const own = this.#deviceKey(deviceId);
    if (own !== undefined) return own;
    const k = this.#all()[deviceId];
    return k !== undefined && this.#live(deviceId) ? k.publicKey : undefined;
  }

  list(): PresenceKeyInfo[] {
    const registered: PresenceKeyInfo[] = Object.entries(this.#all())
      .filter(([deviceId]) => this.#live(deviceId) && this.#deviceKey(deviceId) === undefined)
      .map(([deviceId, k]) => ({
        deviceId,
        keyId: k.keyId,
        registeredAt: k.registeredAt,
        ...(k.kind === undefined ? {} : { kind: k.kind }),
        ...(k.algorithm === undefined ? {} : { algorithm: k.algorithm }),
      }));
    // A Mac helper needs no registration: its device key is its presence key, listed so Settings
    // can say so.
    const own: PresenceKeyInfo[] = listDevices(this.#db)
      .filter((d) => d.pairedAt !== null && getDeviceFamily(this.#db, d.id) === MAC_HELPER_FAMILY)
      .map((d) => ({
        deviceId: d.id,
        keyId: presenceKeyId(d.publicKey),
        registeredAt: d.pairedAt ?? "",
        kind: "device_identity" as const,
        algorithm: "ed25519" as const,
      }));
    return [...own, ...registered];
  }

  #removed(): Record<string, RemovedKey> {
    const v = getSetting(this.#db, PRESENCE_REMOVED_SETTING)?.value;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, RemovedKey>)
      : {};
  }

  /** The key a Remove forgot for `deviceId`, until a Register replaces the record. */
  previous(deviceId: string): RemovedKey | undefined {
    return this.#removed()[deviceId];
  }

  set(
    deviceId: string,
    publicKey: string,
    now: Date,
    kind?: PresenceKeyKind,
    algorithm?: PresenceKeyAlgorithm,
  ): PresenceKeyInfo {
    const stored: StoredKey = {
      publicKey,
      keyId: presenceKeyId(publicKey),
      registeredAt: now.toISOString(),
      ...(kind === undefined ? {} : { kind }),
      ...(algorithm === undefined ? {} : { algorithm }),
    };
    setSetting(this.#db, PRESENCE_KEYS_SETTING, { ...this.#all(), [deviceId]: stored });
    const { [deviceId]: _was, ...stillRemoved } = this.#removed();
    if (_was !== undefined) setSetting(this.#db, PRESENCE_REMOVED_SETTING, stillRemoved);
    return {
      deviceId,
      keyId: stored.keyId,
      registeredAt: stored.registeredAt,
      ...(kind === undefined ? {} : { kind }),
      ...(algorithm === undefined ? {} : { algorithm }),
    };
  }

  /** Forgets the key and remembers which one it was; returns what was removed. */
  remove(
    deviceId: string,
    now: Date = new Date(),
  ): { keyId: string; kind?: PresenceKeyKind } | undefined {
    const all = this.#all();
    const was = all[deviceId];
    if (was === undefined) return undefined;
    const { [deviceId]: _drop, ...rest } = all;
    setSetting(this.#db, PRESENCE_KEYS_SETTING, rest);
    setSetting(this.#db, PRESENCE_REMOVED_SETTING, {
      ...this.#removed(),
      [deviceId]: {
        previousKeyId: was.keyId,
        ...(was.kind === undefined ? {} : { previousKind: was.kind }),
        removedAt: now.toISOString(),
      },
    });
    return { keyId: was.keyId, ...(was.kind === undefined ? {} : { kind: was.kind }) };
  }
}

/**
 * A helper presence key, parsed. Two formats, both base64url, both signing
 * `psyche.presence.helper.v1|<challenge>`:
 * - `ed25519`: the mac-helper's device identity key, 32 raw bytes; 64-byte signatures.
 * - `rsa-2048-pkcs1-sha256`: the win-helper's Windows Hello key (`KeyCredential`), SPKI DER of an
 *   RSA key of at least 2048 bits; PKCS#1 v1.5 / SHA-256 signatures.
 * The format is detected from the bytes; a declared `algorithm` must agree with them.
 */
export interface ParsedPresenceKey {
  algorithm: PresenceKeyAlgorithm;
  key: KeyObject;
}

export type PresenceKeyAlgorithm = "ed25519" | "rsa-2048-pkcs1-sha256";

/** The smallest RSA modulus a presence key may have. */
export const MIN_RSA_PRESENCE_BITS = 2048;

export function parsePresenceKey(b64url: string, declared?: unknown): ParsedPresenceKey | null {
  if (!/^[A-Za-z0-9_-]+$/.test(b64url)) return null;
  if (declared !== undefined && declared !== "ed25519" && declared !== "rsa-2048-pkcs1-sha256") {
    return null;
  }
  const raw = Buffer.from(b64url, "base64url");
  if (raw.length === 32) {
    if (declared !== undefined && declared !== "ed25519") return null;
    try {
      const key = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
        format: "jwk",
      });
      return { algorithm: "ed25519", key };
    } catch {
      return null;
    }
  }
  if (declared !== undefined && declared !== "rsa-2048-pkcs1-sha256") return null;
  let key: KeyObject;
  try {
    key = createPublicKey({ key: raw, format: "der", type: "spki" });
  } catch {
    return null;
  }
  if (key.asymmetricKeyType !== "rsa") return null;
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RSA_PRESENCE_BITS) return null;
  // SPKI DER is canonical: bytes that parse but are not exactly the key's own encoding (trailing
  // data, a non-minimal length) would give the same key two key ids.
  if (!key.export({ format: "der", type: "spki" }).equals(raw)) return null;
  return { algorithm: "rsa-2048-pkcs1-sha256", key };
}

/** Verifies a presence signature with a parsed key, by its algorithm. */
export function verifyPresenceSignature(
  parsed: ParsedPresenceKey,
  message: Buffer,
  signature: Buffer,
): boolean {
  if (parsed.algorithm === "ed25519") {
    return signature.length === 64 && verify(null, message, parsed.key, signature);
  }
  return verify(
    "sha256",
    message,
    { key: parsed.key, padding: constants.RSA_PKCS1_PADDING },
    signature,
  );
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
  // The actor is the device that asked (an admin client), never "system": the log says who did it.
  const audit = (kind: string, data: Record<string, string>, requestedBy?: string) =>
    void deps.audit
      .append({
        kind,
        actor:
          requestedBy === undefined
            ? { type: "system" }
            : { type: "device", deviceId: requestedBy },
        data,
      })
      .catch(() => undefined);
  const helperReason = (err: unknown): string | undefined => {
    const r = ((err ?? {}) as { details?: { reason?: unknown } | null }).details?.reason;
    return typeof r === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(r) ? r : undefined;
  };
  return {
    "devices.presenceKey.list": {
      run: () => ({ presenceKeys: deps.store.list() }),
    },
    "devices.presenceKey.register": {
      async run(
        call: Call,
        params: {
          deviceId: string;
          expectKeyId?: string;
          approvalId?: string;
          confirmReplacesKeyId?: string;
        },
      ) {
        const { deviceId } = params;
        // A Mac helper signs with its device key, which the Gateway pinned at pairing: there is no
        // second key to register, and a registered one would never be used.
        if (deps.store.isDeviceKey(deviceId)) {
          throw new PsycheError(
            "conflict",
            `This Mac's helper needs no ${hostWords().presence} key to register`,
            { details: { reason: "no_key_needed" } },
          );
        }
        // The key id comes from the genuine helper, not from whatever node answers on the socket.
        if (typeof params.expectKeyId !== "string") {
          throw new PsycheError(
            "invalid_params",
            `Registering a ${hostWords().presence} key needs the key id the Psyche Helper shows (expectKeyId)`,
          );
        }
        const nodeId = deps.helperNode(deviceId);
        if (nodeId === undefined) {
          throw new PsycheError(
            "unavailable",
            "That helper is not connected; open Psyche Helper on that computer and try again",
          );
        }
        const res = await deps.invoke(nodeId, "presence.public_key");
        const out = (res.result ?? {}) as {
          publicKey?: unknown;
          keyId?: unknown;
          kind?: unknown;
          algorithm?: unknown;
        };
        // RSA >= 2048 (win-helper's Windows Hello key); a declared algorithm must match the key.
        const parsed =
          res.ok && typeof out.publicKey === "string"
            ? parsePresenceKey(out.publicKey, out.algorithm)
            : null;
        if (!res.ok || typeof out.publicKey !== "string" || parsed === null) {
          const why = helperReason(res.error);
          throw new PsycheError(
            "unavailable",
            `The helper has no usable presence key (${res.error?.code ?? "invalid key"}${why === undefined ? "" : `: ${why}`})`,
            why === undefined ? {} : { details: { reason: why } },
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
        // Only a Windows Hello key credential (TPM-backed, a Hello gesture per signature) is
        // registered: the RSA key Hello makes, reporting that kind. Anything else is refused.
        const kind = kindOf(out.kind);
        if (kind !== "windows_hello" || parsed.algorithm !== "rsa-2048-pkcs1-sha256") {
          throw new PsycheError(
            "forbidden",
            "This helper's presence key is not a Windows Hello key, so it cannot be registered",
            { details: { reason: "key_kind_mismatch" } },
          );
        }
        // Which key this one replaces: the registered one, or the one a Remove just forgot. It is part
        // of what the owner approves (the card names it and the binding covers it), and it is
        // recomputed after the approval, so the approval cannot cover a different replacement.
        const replacedKey = () => {
          const cur = deps.store.list().find((k) => k.deviceId === deviceId);
          if (cur !== undefined) {
            return cur.keyId === keyId
              ? undefined
              : { keyId: cur.keyId, kind: cur.kind, via: "registered" };
          }
          const prev = deps.store.previous(deviceId);
          return prev === undefined || prev.previousKeyId === keyId
            ? undefined
            : { keyId: prev.previousKeyId, kind: prev.previousKind, via: "removed" };
        };
        const replaces = replacedKey();
        // No presence card is possible while no verifier ever existed or after `psyched presence
        // reset`: the owner must then confirm the replacement by naming the old key id.
        if (
          replaces !== undefined &&
          call.ctx.presenceState() === "off" &&
          params.confirmReplacesKeyId !== replaces.keyId
        ) {
          throw new PsycheError(
            "conflict",
            `This replaces the ${hostWords().presence} key ${replaces.keyId.slice(0, 16)}… that was registered for this computer before; confirm to continue`,
            {
              details: {
                reason: "replace_confirmation_required",
                replacesKeyId: replaces.keyId,
                ...(replaces.kind === undefined ? {} : { replacesKind: replaces.kind }),
              },
            },
          );
        }
        // A new verifier: once presence is enrolled, adding one needs the owner's presence.
        await requireFreshPresence(
          call,
          {
            name: "method:devices.presenceKey.register",
            summary:
              replaces === undefined
                ? "Register the Windows helper's Windows Hello key"
                : "REPLACE the Windows helper's Windows Hello key with a different one",
            subject: {
              deviceId,
              keyId,
              ...(replaces === undefined ? {} : { replacesKeyId: replaces.keyId }),
            },
            details: {
              method: "devices.presenceKey.register",
              deviceId,
              keyId,
              ...(replaces === undefined
                ? {}
                : {
                    replacesKeyId: replaces.keyId,
                    ...(replaces.kind === undefined ? {} : { replacesKind: replaces.kind }),
                  }),
            },
          },
          params.approvalId,
          { strong: true },
        );
        if (replacedKey()?.keyId !== replaces?.keyId) {
          throw new PsycheError(
            "conflict",
            `The registered ${hostWords().presence} key changed while this was waiting; start again`,
          );
        }
        const presenceKey = deps.store.set(
          deviceId,
          out.publicKey,
          deps.now(),
          kind,
          parsed.algorithm,
        );
        audit(
          "presence_key.registered",
          {
            deviceId,
            keyId,
            algorithm: parsed.algorithm,
            ...(kind === undefined ? {} : { kind }),
          },
          call.identity.deviceId,
        );
        if (replaces !== undefined) {
          audit(
            "presence_key.replaced",
            {
              deviceId,
              keyId,
              previousKeyId: replaces.keyId,
              previousVia: replaces.via,
              ...(replaces.kind === undefined ? {} : { previousKind: replaces.kind }),
            },
            call.identity.deviceId,
          );
        }
        call.ctx.presenceState(); // records the enrollment (sticky)
        return { presenceKey };
      },
    },
    "devices.presenceKey.remove": {
      run(call: Call, params: { deviceId: string }) {
        // Admin only, as before (narrowing calls need no presence, so the owner can always lock
        // things down), but never silent: who removed which key is logged, and the key is remembered
        // so the next Register says it replaces it.
        const was = deps.store.remove(params.deviceId, deps.now());
        if (was !== undefined) {
          audit(
            "presence_key.removed",
            {
              deviceId: params.deviceId,
              keyId: was.keyId,
              ...(was.kind === undefined ? {} : { kind: was.kind }),
            },
            call.identity.deviceId,
          );
        }
        return { removed: was !== undefined };
      },
    },
  };
}
