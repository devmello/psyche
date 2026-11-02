import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, StringEnum } from "../common.ts";
import { ApprovalKind, Grant } from "../schemas/permissions.ts";
import { defineMethod } from "./define.ts";

/** `grants.*` (architecture §4.6; data model §4). */

/**
 * One row of "what Psyche can reach": a shared folder (kept until revoked, or for one
 * conversation) or a standing grant (a connector, a site, a tool the owner said "always" to).
 * `id` is what `access.revoke` takes.
 */
export const AccessEntry = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 4200 }),
    type: StringEnum(["folder", "grant"]),
    /** `always`: until revoked. `conversation`: this chat only. `limited`: a task, site or session grant. */
    scope: StringEnum(["always", "conversation", "limited"]),
    /** Plain words for the row: the folder path, or what the grant lets Psyche do. */
    label: Type.String({ maxLength: 600 }),
    /** Folders: read-only or read and change. */
    mode: Type.Optional(StringEnum(["ro", "rw"])),
    path: Type.Optional(Type.String({ maxLength: 4096 })),
    threadId: Type.Optional(Id),
    grantId: Type.Optional(Id),
    kind: Type.Optional(ApprovalKind),
    since: Type.Optional(IsoDateTime),
    lastUsedAt: Type.Optional(IsoDateTime),
  },
  { $id: "AccessEntry" },
);
export type AccessEntry = Static<typeof AccessEntry>;

export const GrantsMethods = {
  "access.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ entries: Type.Array(AccessEntry) }),
    scope: "operator.read",
    description:
      "Lists what the owner has given the agent access to: shared folders (always or for one chat) and standing grants, in one list for Settings.",
  }),
  "access.revoke": defineMethod({
    params: Type.Object({ entryId: Type.String({ minLength: 1, maxLength: 4200 }) }),
    result: Type.Object({ revoked: Type.Boolean() }),
    scope: "operator.admin",
    description:
      "Revokes one entry of `access.list` at once (a folder stops working on the next call; a grant is revoked). Changing standing permissions is an admin action.",
  }),
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
