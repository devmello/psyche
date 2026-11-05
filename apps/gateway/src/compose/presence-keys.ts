import { constants, createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import { getDevice, getSetting, type PsycheDb, setSetting } from "@psyche/db";
import { type AuditLog, PsycheError } from "@psyche/protocol";
import { hostWords } from "@psyche/protocol/host-words";
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
 * `kind: enclave_keychain_acl`: a build without a provisioning profile (a self-signed release)
 * keeps its Secure Enclave key as a wrapped blob in a login-keychain item whose access list trusts
 * only the helper's designated requirement. Another program that reads it gets a macOS prompt, so
 * it is accepted in every build. Writing the item is not guarded, so the helper seals it; see
 * security §10 for what a same-user process can still do.
 *
 * Limit (`kind: enclave_file`): a development build may keep the blob as a plain file. Every
 * signature still needs Touch ID inside the Secure Enclave, but any same-user process can read the
 * blob and ask for one behind its own prompt and wording. Same trust boundary as the pairing limit
 * above; refused unless `devices.presence.allowDevFileKey` is on. Settings → Devices names the kind
 * so the owner knows which one is in use.
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

/**
 * Lets a development build register its Secure Enclave file key (`kind: enclave_file`). A
 * `devices.*` security setting: changing it needs `operator.admin` and fresh presence (§10).
 */
export const DEV_FILE_KEY_SETTING = "devices.presence.allowDevFileKey";

export type PresenceKeyKind =
  | "keychain"
  | "enclave_keychain_acl"
  | "enclave_file"
  | "windows_hello";

/** `PresenceKeyInfo` in the protocol. */
export interface PresenceKeyInfo {
  deviceId: string;
  keyId: string;
  registeredAt: string;
  kind?: PresenceKeyKind;
  algorithm?: PresenceKeyAlgorithm;
}

interface StoredKey {
  /** X9.63 uncompressed P-256 point, or SPKI DER of an RSA key; base64url. */
  publicKey: string;
  keyId: string;
  registeredAt: string;
  kind?: PresenceKeyKind;
  /** Absent for keys stored before it was recorded (all P-256). */
  algorithm?: PresenceKeyAlgorithm;
}

function kindOf(v: unknown): PresenceKeyKind | undefined {
  return v === "keychain" ||
    v === "enclave_keychain_acl" ||
    v === "enclave_file" ||
    v === "windows_hello"
    ? v
    : undefined;
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
        ...(k.algorithm === undefined ? {} : { algorithm: k.algorithm }),
      }));
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
 * A helper presence key, parsed. Two formats, both base64url and both signing
 * `psyche.presence.helper.v1|<challenge>` with SHA-256:
 * - `p256-ecdsa-sha256`: the mac-helper's Secure Enclave key, an X9.63 uncompressed point (65
 *   bytes starting with 0x04); DER-encoded ECDSA signatures.
 * - `rsa-2048-pkcs1-sha256`: the win-helper's Windows Hello key (`KeyCredential`), SPKI DER of an
 *   RSA key of at least 2048 bits; PKCS#1 v1.5 signatures.
 * The format is detected from the bytes; a declared `algorithm` must agree with them.
 */
export interface ParsedPresenceKey {
  algorithm: PresenceKeyAlgorithm;
  key: KeyObject;
}

export type PresenceKeyAlgorithm = "p256-ecdsa-sha256" | "rsa-2048-pkcs1-sha256";

/** The smallest RSA modulus a presence key may have. */
export const MIN_RSA_PRESENCE_BITS = 2048;

export function parsePresenceKey(b64url: string, declared?: unknown): ParsedPresenceKey | null {
  if (!/^[A-Za-z0-9_-]+$/.test(b64url)) return null;
  if (
    declared !== undefined &&
    declared !== "p256-ecdsa-sha256" &&
    declared !== "rsa-2048-pkcs1-sha256"
  ) {
    return null;
  }
  const raw = Buffer.from(b64url, "base64url");
  if (raw.length === 65 && raw[0] === 0x04) {
    if (declared !== undefined && declared !== "p256-ecdsa-sha256") return null;
    try {
      const key = createPublicKey({
        key: {
          kty: "EC",
          crv: "P-256",
          x: raw.subarray(1, 33).toString("base64url"),
          y: raw.subarray(33).toString("base64url"),
        },
        format: "jwk",
      });
      return { algorithm: "p256-ecdsa-sha256", key };
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
  if (parsed.algorithm === "p256-ecdsa-sha256") {
    return verify("sha256", message, { key: parsed.key, dsaEncoding: "der" }, signature);
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
  /** `devices.presence.allowDevFileKey`: a development build's file key may be registered. */
  allowDevFileKey(): boolean;
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
        // P-256 (mac-helper) or RSA >= 2048 (win-helper); a declared algorithm must match the key.
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
        // The kind is what the helper says about itself: advisory, not a binding. Only `expectKeyId`
        // (the key id the genuine helper shows) binds the key. A kind this Gateway does not know is
        // refused outright; a missing one and the development file key need the setting.
        const kind = kindOf(out.kind);
        if (out.kind !== undefined && kind === undefined) {
          throw new PsycheError(
            "forbidden",
            "This helper's Touch ID key has a kind this Gateway does not know",
            {
              details: { reason: "unknown_key_kind" },
            },
          );
        }
        // A Windows Hello key credential (TPM-backed, a Hello gesture per signature) is a
        // production key like the Mac's keychain ones, but only as the RSA key Hello makes: a
        // P-256 key claiming the kind is refused, and so is an RSA key claiming a Mac kind.
        const hello = parsed.algorithm === "rsa-2048-pkcs1-sha256";
        if ((kind === "windows_hello") !== hello) {
          throw new PsycheError(
            "forbidden",
            "This helper's presence key does not match the kind it reports",
            { details: { reason: "key_kind_mismatch" } },
          );
        }
        if (
          kind !== "keychain" &&
          kind !== "enclave_keychain_acl" &&
          kind !== "windows_hello" &&
          !deps.allowDevFileKey()
        ) {
          throw new PsycheError(
            "forbidden",
            kind === "enclave_file"
              ? `This helper's Touch ID key is a development Secure Enclave file key; turn on ${DEV_FILE_KEY_SETTING} to register it`
              : `This helper's Touch ID key has no kind; turn on ${DEV_FILE_KEY_SETTING} to register it`,
            {
              details: {
                reason: kind === "enclave_file" ? "dev_file_key_off" : "missing_key_kind",
              },
            },
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
            `This replaces the Touch ID key ${replaces.keyId.slice(0, 16)}… that was registered for this Mac before; confirm to continue`,
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
                ? parsed.algorithm === "rsa-2048-pkcs1-sha256"
                  ? "Register the Windows helper's Windows Hello key"
                  : "Register the Mac helper's Touch ID key"
                : parsed.algorithm === "rsa-2048-pkcs1-sha256"
                  ? "REPLACE the Windows helper's Windows Hello key with a different one"
                  : "REPLACE the Mac helper's Touch ID key with a different one",
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
        );
        if (replacedKey()?.keyId !== replaces?.keyId) {
          throw new PsycheError(
            "conflict",
            "The registered Touch ID key changed while this was waiting; start again",
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
