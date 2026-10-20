import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, JsonObject, Nullable } from "../common.ts";
import { defineMethod, OkResult } from "./define.ts";

/**
 * `passkeys.*`: WebAuthn passkeys for the server-mode web client (security §10, issue #79).
 * Registered per device; a passkey assertion is the web client's fresh user presence for
 * approvals that require authentication and for security settings (`policy_change` cards).
 * Options and responses are the WebAuthn JSON forms (`PublicKeyCredentialCreationOptionsJSON`,
 * `RegistrationResponseJSON`, `AuthenticationResponseJSON`). Available only when the Gateway has
 * an HTTPS `gateway.publicOrigin` (the RP ID is its host); otherwise `unavailable`.
 */

export const PasskeyInfo = Type.Object(
  {
    id: Id,
    deviceId: Id,
    name: Type.String(),
    backedUp: Type.Boolean({ description: "Synced passkey (multi-device credential)" }),
    createdAt: IsoDateTime,
    lastUsedAt: Nullable(IsoDateTime),
  },
  { $id: "PasskeyInfo" },
);
export type PasskeyInfo = Static<typeof PasskeyInfo>;

const CeremonyId = Type.String({ minLength: 1, maxLength: 64 });

/** A passkey assertion from this device, made in the last 5 minutes (`passkeys.reauth.begin`). */
export const PasskeyReauth = Type.Object(
  { ceremonyId: CeremonyId, response: JsonObject },
  { $id: "PasskeyReauth" },
);

export const PasskeysMethods = {
  "passkeys.register.begin": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ ceremonyId: CeremonyId, options: JsonObject }),
    scope: "operator.approvals",
    description:
      "Starts registering a passkey for this device; pass options to navigator.credentials.create().",
  }),
  "passkeys.register.finish": defineMethod({
    params: Type.Object({
      ceremonyId: CeremonyId,
      response: JsonObject,
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      reauth: Type.Optional(PasskeyReauth),
    }),
    result: Type.Object({ passkey: PasskeyInfo }),
    scope: "operator.approvals",
    sideEffecting: true,
    description:
      "Stores the new passkey. A device that already has one must include reauth (an assertion with an existing passkey). At most 20 per device. Side-effecting.",
  }),
  "passkeys.reauth.begin": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ ceremonyId: CeremonyId, options: JsonObject }),
    scope: "operator.approvals",
    description:
      "Assertion options over this device's passkeys, for passkeys.register.finish / passkeys.remove (valid 5 minutes, single use).",
  }),
  "passkeys.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ passkeys: Type.Array(PasskeyInfo) }),
    scope: "operator.read",
    description: "This device's passkeys.",
  }),
  "passkeys.remove": defineMethod({
    params: Type.Object({ passkeyId: Id, reauth: PasskeyReauth }),
    result: OkResult,
    scope: "operator.approvals",
    sideEffecting: true,
    description:
      "Removes one of this device's passkeys; needs a fresh assertion (reauth). Side-effecting.",
  }),
} as const;
