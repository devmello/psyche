import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { CredentialKind, CredentialMeta } from "../schemas/integrations.ts";
import { defineMethod } from "./define.ts";

/** `vault.*` (data model §6). */

/** Vault metadata only. Secret values never cross the protocol; fills happen inside the broker. */
export const VaultMethods = {
  "vault.list": defineMethod({
    params: Type.Object({ kind: Type.Optional(CredentialKind) }),
    result: Type.Object({ credentials: Type.Array(CredentialMeta) }),
    scope: "operator.read",
    description: "Lists credential metadata (never values).",
  }),
  "vault.get": defineMethod({
    params: Type.Object({ credentialId: Id }),
    result: Type.Object({ credential: CredentialMeta }),
    scope: "operator.read",
    description: "Returns one credential's metadata (never its value).",
  }),
} as const;
