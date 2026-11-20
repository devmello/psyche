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
    /** A conversation row for one attached file, not a folder. */
    file: Type.Optional(Type.Boolean()),
    path: Type.Optional(Type.String({ maxLength: 4096 })),
    /**
     * A folder row the Gateway no longer honours: it is a sensitive root today (`/opt`, `/usr`,
     * `~/.ssh`...), so it covers nothing. Revoke is still offered.
     */
    refused: Type.Optional(Type.Boolean()),
    /**
     * With `refused`: a folder kept until revoked, granted before Psyche recorded where each
     * folder really is, that now leads somewhere else (`movedTo`). It covers nothing until the
     * owner confirms it again there (`access.confirmFolder`).
     */
    moved: Type.Optional(Type.Boolean()),
    movedTo: Type.Optional(Type.String({ maxLength: 4096 })),
    /**
     * A folder kept until revoked whose path is gone (renamed or moved in Finder) while the same
     * folder, by its recorded identity, is at `reconnectTo` now. Settings asks "Reconnect <name>?";
     * one tap sends `access.reconnectFolder`. Never applied without that tap.
     */
    reconnectTo: Type.Optional(Type.String({ maxLength: 4096 })),
    /**
     * With no `reconnectTo`: the same folder was found elsewhere but cannot be reconnected safely
     * (a deny or ask rule names its old place, or a wider folder inside it cannot be verified).
     * Settings says so instead of offering a button that can only fail.
     */
    reconnectBlocked: Type.Optional(Type.Boolean()),
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
  "access.confirmFolder": defineMethod({
    params: Type.Object({
      entryId: Type.String({ minLength: 1, maxLength: 4200 }),
      /** The row's `movedTo`, as the owner saw it: confirmed only while the folder still leads there. */
      movedTo: Type.String({ minLength: 1, maxLength: 4096 }),
    }),
    result: Type.Object({ confirmed: Type.Boolean() }),
    scope: "operator.admin",
    description:
      "Confirms again a folder row of `access.list` marked `moved`: the folder is looked up now and shared where it leads, only if that is still `movedTo` (the place the owner saw) and a grant there would not be refused. A plain tap from an admin device, recorded and reported as that device's security setting change. False when there is nothing to confirm or the folder leads somewhere else now (read the list again).",
  }),
  "access.reconnectFolder": defineMethod({
    params: Type.Object({
      entryId: Type.String({ minLength: 1, maxLength: 4200 }),
      /** The row's `reconnectTo`, as the owner saw it. */
      to: Type.String({ minLength: 1, maxLength: 4096 }),
    }),
    result: Type.Object({ reconnected: Type.Boolean() }),
    scope: "operator.admin",
    description:
      "Re-points a folder row of `access.list` that has `reconnectTo` (the owner renamed or moved it): the new place goes through every check of a fresh grant again and must be the same folder (volume and inode) with the old path gone. A plain tap from an admin device. False when there is nothing to reconnect, the old path is back, the target is a link or a different folder (read the list again); `forbidden` when a grant there would be refused.",
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
