import type { ApprovalRequest } from "@psyche/protocol";
import { describeError, errorCode, type PresenceAssertion, t } from "@psyche/ui";
import { toBase64Url } from "../client/encoding.ts";

/**
 * WebAuthn passkeys for the server-mode web client (security §10, issue #79). The Gateway's
 * `passkeys.*` methods speak the WebAuthn JSON forms; this module turns them into browser calls
 * and builds the `webauthn` presence assertion an approval that requires authentication carries
 * on `approvals.answer`. The challenge of that assertion is the approval's presence challenge
 * `sha256("psyche.presence.v1|<approvalId>|<bindingHash>|<answerToken>")`, its 32 raw bytes.
 */

/** `AuthenticationResponseJSON` (every binary field base64url). */
export interface AuthenticationJSON {
  id: string;
  rawId: string;
  type: string;
  response: {
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
    userHandle?: string | null;
  };
  clientExtensionResults?: Record<string, unknown>;
  authenticatorAttachment?: string | null;
}

/** The browser's passkey API in its JSON form: `navigator.credentials`, or a double in tests. */
export interface PasskeyAuthenticator {
  /** `PublicKeyCredentialCreationOptionsJSON` in, `RegistrationResponseJSON` out. */
  create(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** `PublicKeyCredentialRequestOptionsJSON` in, `AuthenticationResponseJSON` out. */
  get(options: Record<string, unknown>): Promise<AuthenticationJSON>;
}

/** What the web host gives the app for passkeys (`ShellPlatform.passkeys`). */
export interface PasskeyHost {
  /** This browser's paired device id: presence assertions name it. */
  deviceId(): Promise<string>;
  authenticator: PasskeyAuthenticator;
}

/** The JSON helpers on `PublicKeyCredential` (Chrome 129, Safari 18.4, Firefox 119). */
interface PublicKeyCredentialJSONStatics {
  parseCreationOptionsFromJSON(options: unknown): unknown;
  parseRequestOptionsFromJSON(options: unknown): unknown;
}

interface WebAuthnGlobals {
  isSecureContext?: boolean;
  PublicKeyCredential?: Partial<PublicKeyCredentialJSONStatics>;
  navigator?: {
    credentials?: {
      create(options: CredentialCreationOptions): Promise<unknown>;
      get(options: CredentialRequestOptions): Promise<unknown>;
    };
  };
}

/** Thrown when the browser returns no credential (it should reject instead, but some don't). */
export class PasskeyCancelled extends Error {
  constructor() {
    super(t("web.webauthn.noPasskey"));
    this.name = "PasskeyCancelled";
  }
}

function toJSON(credential: unknown): unknown {
  const c = credential as { toJSON?: () => unknown } | null;
  if (!c || typeof c.toJSON !== "function") throw new PasskeyCancelled();
  return c.toJSON();
}

/**
 * `navigator.credentials` in JSON form, or `null` where passkeys can't work: an insecure context
 * (plain http other than localhost) or a browser without the WebAuthn JSON helpers.
 */
export function browserAuthenticator(
  g: WebAuthnGlobals = globalThis as WebAuthnGlobals,
): PasskeyAuthenticator | null {
  const pkc = g.PublicKeyCredential;
  const credentials = g.navigator?.credentials;
  if (
    g.isSecureContext !== true ||
    !credentials ||
    typeof pkc?.parseCreationOptionsFromJSON !== "function" ||
    typeof pkc.parseRequestOptionsFromJSON !== "function"
  ) {
    return null;
  }
  const statics = pkc as PublicKeyCredentialJSONStatics;
  return {
    async create(options) {
      const publicKey = statics.parseCreationOptionsFromJSON(options);
      return toJSON(await credentials.create({ publicKey } as CredentialCreationOptions)) as Record<
        string,
        unknown
      >;
    },
    async get(options) {
      const publicKey = statics.parseRequestOptionsFromJSON(options);
      return toJSON(
        await credentials.get({ publicKey } as CredentialRequestOptions),
      ) as AuthenticationJSON;
    },
  };
}

/** The approval's presence challenge (hex), as the Permission Broker computes it. */
export async function presenceChallengeHex(
  approvalId: string,
  bindingHash: string,
  answerToken: string,
): Promise<string> {
  const text = `psyche.presence.v1|${approvalId}|${bindingHash}|${answerToken}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The WebAuthn challenge for a hex presence challenge: its raw bytes, base64url. */
export function webauthnChallenge(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return toBase64Url(bytes);
}

/** `ApprovalAnswer.presence` from an assertion by one of this device's passkeys. */
export function presenceFromAssertion(
  deviceId: string,
  assertion: AuthenticationJSON,
): PresenceAssertion {
  const r = assertion.response;
  return {
    kind: "webauthn",
    deviceId,
    signature: r.signature,
    payload: {
      credentialId: assertion.id,
      authenticatorData: r.authenticatorData,
      clientDataJSON: r.clientDataJSON,
      ...(r.userHandle ? { userHandle: r.userHandle } : {}),
    },
  };
}

/** A Gateway call, as the kit's `useCall()` or the shell's port makes it. */
export type PasskeyCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

interface Ceremony {
  ceremonyId: string;
  options: Record<string, unknown>;
}

/** A fresh assertion with one of this device's passkeys (`reauth` of register / remove). */
export async function reauthenticate(
  call: PasskeyCall,
  authenticator: PasskeyAuthenticator,
): Promise<{ ceremonyId: string; response: Record<string, unknown> }> {
  const begin = (await call("passkeys.reauth.begin", {})) as Ceremony;
  const response = await authenticator.get(begin.options);
  return { ceremonyId: begin.ceremonyId, response: { ...response } };
}

/**
 * Presence for one approval: an assertion over its presence challenge by one of this device's
 * passkeys. `passkeys.reauth.begin` supplies the RP ID and this device's credential ids (with
 * transports), which `PasskeyInfo` does not carry; its own challenge is replaced and its ceremony
 * left to expire.
 */
export async function approvalPresence(
  call: PasskeyCall,
  host: PasskeyHost,
  approval: Pick<ApprovalRequest, "id" | "bindingHash">,
  answerToken: string,
): Promise<PresenceAssertion> {
  const [hex, deviceId] = await Promise.all([
    presenceChallengeHex(approval.id, approval.bindingHash, answerToken),
    host.deviceId(),
  ]);
  let begin: Ceremony;
  try {
    begin = (await call("passkeys.reauth.begin", {})) as Ceremony;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "not_found") {
      throw new Error(t("web.webauthn.noPasskeyYet"));
    }
    if (code === "unavailable") {
      throw new Error(t("web.webauthn.needsOrigin"));
    }
    throw err;
  }
  const assertion = await host.authenticator.get({
    ...begin.options,
    challenge: webauthnChallenge(hex),
  });
  return presenceFromAssertion(deviceId, assertion);
}

/** Text for a failed passkey prompt: a cancel is not an error worth a stack of words. */
export function passkeyErrorText(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  if (err instanceof PasskeyCancelled || name === "NotAllowedError" || name === "AbortError") {
    return t("web.webauthn.cancelled");
  }
  if (name === "InvalidStateError") return t("web.webauthn.alreadyRegistered");
  if (name === "SecurityError") {
    return t("web.webauthn.wrongDomain");
  }
  // Gateway errors go through the catalogue; this module's own errors are already localized.
  if (errorCode(err) !== null) return describeError(err);
  return err instanceof Error ? err.message : String(err);
}
