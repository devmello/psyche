import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { ApprovalKind, Grant } from "../schemas/permissions.ts";
import { defineMethod } from "./define.ts";

/** `grants.*` (architecture §4.6; data model §4). */

export const GrantsMethods = {
  "grants.list": defineMethod({
    params: Type.Object({
      kind: Type.Optional(ApprovalKind),
      includeRevoked: Type.Optional(Type.Boolean()),
    }),
    result: Type.Object({ grants: Type.Array(Grant) }),
    scope: "operator.read",
    description: "Lists standing grants with use counts and expiry.",
  }),
  "grants.revoke": defineMethod({
    params: Type.Object({ grantId: Id }),
    result: Type.Object({ grant: Grant }),
    scope: "operator.admin",
    description: "Revokes a grant; changing standing permissions is an admin action.",
  }),
} as const;
