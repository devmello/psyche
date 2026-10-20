import { randomBytes } from "node:crypto";
import {
  countActivePasskeys,
  deletePasskey,
  getDevice,
  getPasskeyByCredential,
  insertPasskey,
  listPasskeys,
  type PsycheDb,
  recordPasskeyUse,
  type StoredPasskey,
} from "@psyche/db";
import type { PresenceAssertion, PresenceVerifier } from "@psyche/permissions";
import { type PasskeyInfo, PsycheError } from "@psyche/protocol";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Call, HandlerDef } from "../context.ts";
import { RateLimiter } from "../rate-limit.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * WebAuthn passkeys for the server-mode web client (security §10, issue #79). A passkey belongs to
 * one paired device. Its assertion over an approval's presence challenge is that device's fresh
 * user presence (`ApprovalAnswer.presence`, kind `webauthn`), which S05's broker requires for
 * approvals that need authentication and, once any verifier is ready, for security settings
 * (`policy_change` cards, #178). Rules from §10: RP ID = the public origin's host, at most 20
 * passkeys per device, 20 verification attempts per address or device per 5 minutes. A device that
 * already has a passkey must re-authenticate with one to add or remove another, so a stolen device
 * key cannot quietly swap in the attacker's passkey.
 */

// Failures use `forbidden`, never `unauthorized`: the connection treats `unauthorized` as a failed
// handshake and closes, which would drop the device for a mistyped passkey.

export const MAX_PASSKEYS_PER_DEVICE = 20;
export const PASSKEY_ATTEMPTS = { limit: 20, windowMs: 5 * 60_000 };
/** Ceremony (challenge) lifetime: the fresh re-auth window. */
export const CEREMONY_TTL_MS = 5 * 60_000;

export interface PasskeySetup {
  /** The HTTPS origin the web client runs on; default `config.publicOrigin`. */
  publicOrigin?: string | null;
  rpName?: string;
}

interface Ceremony {
  deviceId: string;
  kind: "register" | "reauth";
  challenge: string;
  expiresAt: number;
}

function info(p: StoredPasskey): PasskeyInfo {
  return {
    id: p.id,
    deviceId: p.deviceId,
    name: p.name,
    backedUp: p.backedUp,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
  };
}

/**
 * The WebAuthn challenge for an approval's presence challenge (`sha256:<hex>` from the broker, or
 * bare hex): its 32 raw bytes, base64url. Without stripping the prefix, `Buffer.from(…, "hex")`
 * stops at the `s` and every challenge would be empty.
 */
export function webauthnChallengeFor(presenceChallenge: string): string {
  const hex = presenceChallenge.startsWith("sha256:")
    ? presenceChallenge.slice(7)
    : presenceChallenge;
  return Buffer.from(hex, "hex").toString("base64url");
}

export class PasskeyService {
  readonly #db: PsycheDb;
  readonly #origin: string | null;
  readonly #rpName: string;
  readonly #now: () => number;
  readonly #ceremonies = new Map<string, Ceremony>();
  readonly #attempts: RateLimiter;

  constructor(
    db: PsycheDb,
    origin: string | null,
    options: { rpName?: string; now?: () => number } = {},
  ) {
    this.#db = db;
    this.#origin = origin;
    this.#rpName = options.rpName ?? "Psyche";
    this.#now = options.now ?? Date.now;
    this.#attempts = new RateLimiter(PASSKEY_ATTEMPTS.limit, PASSKEY_ATTEMPTS.windowMs, this.#now);
  }

  get rpID(): string | null {
    return this.#origin === null ? null : new URL(this.#origin).hostname;
  }

  /** True once a paired, non-revoked device has a passkey (the presence-ready check, #178). */
  ready(): boolean {
    return this.#origin !== null && countActivePasskeys(this.#db) > 0;
  }

  #require(): { origin: string; rpID: string } {
    if (this.#origin === null) {
      throw new PsycheError(
        "unavailable",
        "passkeys need gateway.publicOrigin (an https:// origin)",
      );
    }
    return { origin: this.#origin, rpID: new URL(this.#origin).hostname };
  }

  #attempt(key: string): void {
    if (!this.#attempts.allowed(key)) {
      throw new PsycheError(
        "rate_limited",
        "too many passkey attempts; try again in a few minutes",
        {
          retryable: true,
        },
      );
    }
    this.#attempts.record(key);
  }

  #ceremony(id: string, deviceId: string, kind: Ceremony["kind"]): Ceremony {
    const c = this.#ceremonies.get(id);
    this.#ceremonies.delete(id); // single use
    if (!c || c.deviceId !== deviceId || c.kind !== kind || c.expiresAt < this.#now()) {
      throw new PsycheError("forbidden", "unknown or expired passkey ceremony");
    }
    return c;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, c] of this.#ceremonies) if (c.expiresAt < now) this.#ceremonies.delete(id);
  }

  #newCeremony(deviceId: string, kind: Ceremony["kind"], challenge: string): string {
    this.#sweep();
    const id = randomBytes(16).toString("base64url");
    this.#ceremonies.set(id, {
      deviceId,
      kind,
      challenge,
      expiresAt: this.#now() + CEREMONY_TTL_MS,
    });
    return id;
  }

  async registerBegin(
    deviceId: string,
  ): Promise<{ ceremonyId: string; options: Record<string, unknown> }> {
    const { rpID } = this.#require();
    const device = getDevice(this.#db, deviceId);
    if (!device) throw new PsycheError("not_found", "device not found");
    const existing = listPasskeys(this.#db, deviceId);
    if (existing.length >= MAX_PASSKEYS_PER_DEVICE) {
      throw new PsycheError(
        "conflict",
        `a device can have at most ${MAX_PASSKEYS_PER_DEVICE} passkeys`,
      );
    }
    const options = await generateRegistrationOptions({
      rpName: this.#rpName,
      rpID,
      userName: device.name || deviceId,
      userID: new TextEncoder().encode(deviceId),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    return {
      ceremonyId: this.#newCeremony(deviceId, "register", options.challenge),
      options: options as unknown as Record<string, unknown>,
    };
  }

  async registerFinish(
    deviceId: string,
    address: string,
    input: {
      ceremonyId: string;
      response: unknown;
      name?: string;
      reauth?: { ceremonyId: string; response: unknown };
    },
  ): Promise<PasskeyInfo> {
    const { origin, rpID } = this.#require();
    this.#attempt(`addr:${address}`);
    const ceremony = this.#ceremony(input.ceremonyId, deviceId, "register");
    const existing = listPasskeys(this.#db, deviceId);
    if (existing.length > 0) {
      if (!input.reauth) {
        throw new PsycheError(
          "forbidden",
          "this device already has a passkey: re-authenticate with it first",
        );
      }
      await this.#verifyReauth(deviceId, input.reauth);
    }
    if (existing.length >= MAX_PASSKEYS_PER_DEVICE) {
      throw new PsycheError(
        "conflict",
        `a device can have at most ${MAX_PASSKEYS_PER_DEVICE} passkeys`,
      );
    }
    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verified = await verifyRegistrationResponse({
        response: input.response as RegistrationResponseJSON,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch {
      throw new PsycheError("forbidden", "passkey registration did not verify");
    }
    if (!verified.verified)
      throw new PsycheError("forbidden", "passkey registration did not verify");
    const { credential, credentialBackedUp } = verified.registrationInfo;
    if (getPasskeyByCredential(this.#db, credential.id)) {
      throw new PsycheError("conflict", "this passkey is already registered");
    }
    const stored = insertPasskey(this.#db, {
      deviceId,
      credentialId: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? [],
      name: input.name ?? "Passkey",
      backedUp: credentialBackedUp,
    });
    return info(stored);
  }

  async reauthBegin(
    deviceId: string,
  ): Promise<{ ceremonyId: string; options: Record<string, unknown> }> {
    const { rpID } = this.#require();
    const existing = listPasskeys(this.#db, deviceId);
    if (existing.length === 0) throw new PsycheError("not_found", "this device has no passkey");
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
      userVerification: "required",
    });
    return {
      ceremonyId: this.#newCeremony(deviceId, "reauth", options.challenge),
      options: options as unknown as Record<string, unknown>,
    };
  }

  async #verifyReauth(
    deviceId: string,
    reauth: { ceremonyId: string; response: unknown },
  ): Promise<void> {
    const ceremony = this.#ceremony(reauth.ceremonyId, deviceId, "reauth");
    const ok = await this.#verifyAssertion(
      deviceId,
      reauth.response as AuthenticationResponseJSON,
      ceremony.challenge,
    );
    if (!ok) throw new PsycheError("forbidden", "passkey re-authentication failed");
  }

  /** One assertion by one of `deviceId`'s passkeys over `expectedChallenge` (base64url). */
  async #verifyAssertion(
    deviceId: string,
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
  ): Promise<boolean> {
    const { origin, rpID } = this.#require();
    const stored =
      typeof response?.id === "string" ? getPasskeyByCredential(this.#db, response.id) : undefined;
    if (!stored || stored.deviceId !== deviceId) return false;
    const device = getDevice(this.#db, deviceId);
    if (!device || device.revokedAt || !device.pairedAt) return false;
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: stored.credentialId,
          publicKey: new Uint8Array(stored.publicKey),
          counter: stored.counter,
          transports: stored.transports,
        },
      });
      if (!result.verified) return false;
      recordPasskeyUse(this.#db, stored.id, result.authenticationInfo.newCounter);
      return true;
    } catch {
      return false;
    }
  }

  list(deviceId: string): PasskeyInfo[] {
    return listPasskeys(this.#db, deviceId).map(info);
  }

  async remove(
    deviceId: string,
    address: string,
    input: { passkeyId: string; reauth: { ceremonyId: string; response: unknown } },
  ): Promise<void> {
    this.#require();
    this.#attempt(`addr:${address}`);
    await this.#verifyReauth(deviceId, input.reauth);
    if (!deletePasskey(this.#db, input.passkeyId, deviceId)) {
      throw new PsycheError("not_found", "passkey not found on this device");
    }
  }

  /** `PresenceVerifier` for `webauthn` assertions on approval answers (S05 broker). */
  verifier(): PresenceVerifier {
    return {
      verify: async (assertion: PresenceAssertion, challenge: string, deviceId: string) => {
        if (
          assertion.kind !== "webauthn" ||
          assertion.deviceId !== deviceId ||
          this.#origin === null
        ) {
          return false;
        }
        if (!this.#attempts.allowed(`dev:${deviceId}`)) return false;
        this.#attempts.record(`dev:${deviceId}`);
        const p = assertion.payload ?? {};
        const { credentialId, authenticatorData, clientDataJSON, userHandle } = p;
        if (!credentialId || !authenticatorData || !clientDataJSON) return false;
        const response: AuthenticationResponseJSON = {
          id: credentialId,
          rawId: credentialId,
          type: "public-key",
          clientExtensionResults: {},
          response: {
            authenticatorData,
            clientDataJSON,
            signature: assertion.signature,
            ...(userHandle ? { userHandle } : {}),
          },
        };
        return this.#verifyAssertion(deviceId, response, webauthnChallengeFor(challenge));
      },
    };
  }
}

export function composePasskeys(setup: PasskeySetup = {}) {
  return (services: ComposeServices): ComposedPart => {
    let service: PasskeyService | null = null;
    const get = (): PasskeyService => {
      if (!service) throw new PsycheError("unavailable", "the Gateway is not running yet");
      return service;
    };
    // Built eagerly so the broker's verifier and ready() work before the Gateway starts.
    service = new PasskeyService(services.db, setup.publicOrigin ?? null, {
      ...(setup.rpName === undefined ? {} : { rpName: setup.rpName }),
    });
    const address = (call: Call) => call.conn.peer.remoteAddress;
    const handlers: Record<string, HandlerDef> = {
      "passkeys.register.begin": {
        run: (call: Call) => get().registerBegin(call.identity.deviceId),
      },
      "passkeys.register.finish": {
        run: async (call: Call, params: never) => ({
          passkey: await get().registerFinish(call.identity.deviceId, address(call), params),
        }),
      },
      "passkeys.reauth.begin": { run: (call: Call) => get().reauthBegin(call.identity.deviceId) },
      "passkeys.list": { run: (call: Call) => ({ passkeys: get().list(call.identity.deviceId) }) },
      "passkeys.remove": {
        run: async (call: Call, params: never) => {
          await get().remove(call.identity.deviceId, address(call), params);
          return { ok: true as const };
        },
      },
    };
    const s = service;
    return {
      handlers,
      presence: { kind: "webauthn", verifier: s.verifier(), ready: () => s.ready() },
    };
  };
}
