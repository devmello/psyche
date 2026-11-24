import { type Static, Type } from "@sinclair/typebox";
import { Id, Nullable, PermissionMode } from "../common.ts";
import {
  SPACE_LIMITS,
  Space,
  SpaceContextSection,
  SpaceDetail,
  SpaceFolderMode,
  SpaceLink,
  SpaceLinkKind,
  SpaceMigrationOffer,
  SpaceOffers,
  SpaceProposal,
  SpaceSummary,
  SpaceTrackerTemplate,
  SpaceTrackerValue,
} from "../schemas/spaces.ts";
import { defineMethod, OkResult } from "./define.ts";

/** `spaces.*` (docs/design/spaces-2026.md §4.2). Method table only; handlers come in S1+. */

export const SpaceResult = Type.Object({ space: Space }, { $id: "SpaceResult" });
export type SpaceResult = Static<typeof SpaceResult>;

const SpaceIdParams = Type.Object({ spaceId: Id });

const spaceFields = {
  name: Type.String({ minLength: 1, maxLength: SPACE_LIMITS.name }),
  description: Type.String({ maxLength: SPACE_LIMITS.description }),
  icon: Type.String({ minLength: 1, maxLength: 40 }),
  instructions: Type.String({ maxLength: SPACE_LIMITS.instructions }),
};

export const SpacesMethods = {
  "spaces.list": defineMethod({
    params: Type.Object({ archived: Type.Optional(Type.Boolean()) }),
    result: Type.Object({ spaces: Type.Array(SpaceSummary) }),
    scope: "operator.read",
    description:
      "Spaces in sort order, with counts (chats, trackers, due items) and lastActivityAt. archived: true lists archived ones.",
  }),
  "spaces.get": defineMethod({
    params: SpaceIdParams,
    result: SpaceDetail,
    scope: "operator.read",
    description: "One Space with folders, links, trackers, automations and goals.",
  }),
  "spaces.create": defineMethod({
    params: Type.Object({
      name: spaceFields.name,
      description: Type.Optional(spaceFields.description),
      icon: Type.Optional(spaceFields.icon),
      instructions: Type.Optional(spaceFields.instructions),
      entityId: Type.Optional(Id),
    }),
    result: SpaceResult,
    scope: "operator.write",
    sideEffecting: true,
    description: "Creates a Space. Side-effecting: a retried key returns the same Space.",
  }),
  "spaces.update": defineMethod({
    params: Type.Object({
      spaceId: Id,
      name: Type.Optional(spaceFields.name),
      description: Type.Optional(Nullable(spaceFields.description)),
      icon: Type.Optional(Nullable(spaceFields.icon)),
      instructions: Type.Optional(spaceFields.instructions),
      entityId: Type.Optional(Nullable(Id)),
      private: Type.Optional(Type.Boolean()),
      sort: Type.Optional(Type.Integer()),
    }),
    result: SpaceResult,
    scope: "operator.write",
    description:
      "Edits a Space. Bumps instructionsRev when the instructions change; a new revision applies from the next run.",
  }),
  "spaces.archive": defineMethod({
    params: SpaceIdParams,
    result: SpaceResult,
    scope: "operator.write",
    description:
      "Archives a Space: hidden everywhere but the palette's Archived Spaces, its automations pause and its folders stop working.",
  }),
  "spaces.restore": defineMethod({
    params: SpaceIdParams,
    result: SpaceResult,
    scope: "operator.write",
    description: "Restores an archived Space.",
  }),
  "spaces.delete": defineMethod({
    params: SpaceIdParams,
    result: OkResult,
    scope: "operator.admin",
    description:
      "Deletes a Space. Threads and automations stay with no Space, trackers return to their thread, folders are revoked and the memory project is untouched.",
  }),
  "spaces.folders.add": defineMethod({
    params: Type.Object({
      spaceId: Id,
      path: Type.Optional(
        Type.String({ minLength: 1, description: "Omit on the Host to open the native picker" }),
      ),
      mode: Type.Optional(SpaceFolderMode),
    }),
    result: SpaceDetail,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Adds a folder to a Space (the same refusals as Settings → File access). Side-effecting.",
  }),
  "spaces.folders.remove": defineMethod({
    params: Type.Object({ spaceId: Id, path: Type.String({ minLength: 1 }) }),
    result: SpaceDetail,
    scope: "operator.admin",
    description: "Removes a folder from a Space and revokes it at once.",
  }),
  "spaces.folders.setMode": defineMethod({
    params: Type.Object({
      spaceId: Id,
      path: Type.String({ minLength: 1 }),
      mode: SpaceFolderMode,
    }),
    result: SpaceDetail,
    scope: "operator.admin",
    description: "Sets a Space folder to read only or read and write.",
  }),
  "spaces.settings.set": defineMethod({
    params: Type.Object({
      spaceId: Id,
      defaultPermissionMode: Type.Optional(Nullable(PermissionMode)),
      connectorScope: Type.Optional(
        Nullable(Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 })),
      ),
      automationsWrite: Type.Optional(
        Type.Array(Type.Object({ path: Type.String({ minLength: 1 }), allow: Type.Boolean() }), {
          maxItems: 100,
          description: "Per folder: unattended runs may write here (SP8)",
        }),
      ),
    }),
    result: SpaceDetail,
    scope: "operator.admin",
    description:
      "Owner settings: default permission mode (capped by the global setting), connector scope (only narrows) and per-folder automationsWrite.",
  }),
  "spaces.links.add": defineMethod({
    params: Type.Object({
      spaceId: Id,
      kind: SpaceLinkKind,
      ref: Type.String({ minLength: 1 }),
      label: Type.String({ minLength: 1, maxLength: SPACE_LIMITS.linkLabel }),
    }),
    result: Type.Object({ link: SpaceLink }),
    scope: "operator.write",
    description: "Adds an owner link to a Space.",
  }),
  "spaces.links.remove": defineMethod({
    params: Type.Object({ spaceId: Id, linkId: Id }),
    result: OkResult,
    scope: "operator.write",
    description: "Removes a link from a Space.",
  }),
  "spaces.threads.move": defineMethod({
    params: Type.Object({
      threadIds: Type.Array(Id, { minItems: 1, maxItems: SPACE_LIMITS.moveBatch }),
      spaceId: Nullable(Id),
    }),
    result: Type.Object({ moved: Type.Integer({ minimum: 0 }) }),
    scope: "operator.write",
    description:
      "Moves up to 50 threads into a Space, or out (spaceId null). Takes effect from each thread's next run.",
  }),
  "spaces.automations.move": defineMethod({
    params: Type.Object({
      automationIds: Type.Array(Id, { minItems: 1, maxItems: SPACE_LIMITS.moveBatch }),
      spaceId: Nullable(Id),
    }),
    result: Type.Object({ moved: Type.Integer({ minimum: 0 }) }),
    scope: "operator.write",
    description: "Moves up to 50 automations into a Space, or out (spaceId null).",
  }),
  "spaces.trackers.add": defineMethod({
    params: Type.Object({
      spaceId: Id,
      widgetId: Type.Optional(Id),
      template: Type.Optional(SpaceTrackerTemplate),
      automationId: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 64,
          description:
            "With widgetId: the automation of this Space that Refresh runs for an agent tracker (the owner's link)",
        }),
      ),
    }),
    result: SpaceDetail,
    scope: "operator.write",
    description: "Puts a tracker on the shelf, from an existing widget (widgetId) or a template.",
  }),
  "spaces.trackers.remove": defineMethod({
    params: Type.Object({ spaceId: Id, widgetId: Id }),
    result: SpaceDetail,
    scope: "operator.write",
    description: "Removes a tracker from the shelf; the widget returns to its thread.",
  }),
  "spaces.trackers.reorder": defineMethod({
    params: Type.Object({
      spaceId: Id,
      widgetIds: Type.Array(Id, { maxItems: SPACE_LIMITS.trackers }),
    }),
    result: SpaceDetail,
    scope: "operator.write",
    description: "Reorders the shelf.",
  }),
  "spaces.trackers.refresh": defineMethod({
    callsModel: true,
    params: Type.Object({ spaceId: Id, widgetId: Id }),
    result: Type.Object({ tracker: SpaceTrackerValue }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "The owner's Refresh: a query tracker recomputes at once; an agent tracker starts its one run. Side-effecting.",
  }),
  "spaces.open": defineMethod({
    params: SpaceIdParams,
    result: Type.Object({ trackers: Type.Array(SpaceTrackerValue) }),
    scope: "operator.read",
    description:
      "Called when the Space page opens: recomputes stale query trackers (no model call) and returns their values. Rate-limited to one recompute per Space per 30 s.",
  }),
  "spaces.context.preview": defineMethod({
    params: Type.Object({ spaceId: Id, threadId: Type.Optional(Id) }),
    result: Type.Object({ sections: Type.Array(SpaceContextSection) }),
    scope: "operator.read",
    description:
      "What Psyche sees here: the exact Space card and head section a run in this Space would get, with sizes.",
  }),
  "spaces.proposals.list": defineMethod({
    params: Type.Object({ status: Type.Optional(Type.Literal("open")) }),
    result: Type.Object({ proposals: Type.Array(SpaceProposal) }),
    scope: "operator.read",
    description: "Space proposals the agent made.",
  }),
  "spaces.proposals.accept": defineMethod({
    params: Type.Object({ proposalId: Id, name: Type.Optional(spaceFields.name) }),
    result: SpaceResult,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Accepts a proposal: creates the Space and moves the named threads in. Side-effecting.",
  }),
  "spaces.proposals.dismiss": defineMethod({
    params: Type.Object({ proposalId: Id }),
    result: OkResult,
    scope: "operator.write",
    description: "Dismisses a proposal.",
  }),
  "spaces.migration.offer": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ offer: Nullable(SpaceMigrationOffer) }),
    scope: "operator.read",
    description:
      "The one-time offer to make Spaces for up to 5 active, non-private projects with at least two owner or rule anchors. null once decided or when nothing qualifies.",
  }),
  "spaces.migration.apply": defineMethod({
    params: Type.Object({ entityIds: Type.Array(Id, { minItems: 1, maxItems: 5 }) }),
    result: Type.Object({ spaces: Type.Array(Space) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Side-effecting. The owner's Create on the migration offer: one Space per checked project (createdFrom migration), linked, with the project's anchored chats moved in. Closes the offer.",
  }),
  "spaces.migration.dismiss": defineMethod({
    params: Type.Object({}),
    result: OkResult,
    scope: "operator.write",
    description: "Closes the migration offer without creating anything.",
  }),
  "spaces.offers.list": defineMethod({
    params: SpaceIdParams,
    result: SpaceOffers,
    scope: "operator.read",
    description:
      "Offers for a Space after chats moved in: pinned widgets of those chats for the shelf, and the owner-provenance standing instructions of those chats. Untrusted pins are never offered.",
  }),
  "spaces.offers.dismiss": defineMethod({
    params: Type.Object({ spaceId: Id, offerId: Type.String({ minLength: 1, maxLength: 80 }) }),
    result: OkResult,
    scope: "operator.write",
    description: "Dismisses one offer so it does not come back.",
  }),
} as const;
