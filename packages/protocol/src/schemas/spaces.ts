import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, PermissionMode, StringEnum } from "../common.ts";
import { TaintSource } from "./permissions.ts";

/**
 * Spaces: lasting workspaces for a project, its files, chats and trackers
 * (docs/design/spaces-2026.md §4). A Space is a container, not a store: it holds ids and owner
 * settings. Types only; the handlers arrive in wave S1.
 */

const Strict = { additionalProperties: false } as const;

export const SPACE_LIMITS = {
  name: 60,
  description: 160,
  instructions: 4000,
  linkLabel: 120,
  trackers: 12,
  moveBatch: 50,
} as const;

export const SpaceCreatedFrom = StringEnum(["owner", "proposal", "project", "migration"], {
  $id: "SpaceCreatedFrom",
});
export type SpaceCreatedFrom = Static<typeof SpaceCreatedFrom>;

export const SpaceFolderMode = StringEnum(["ro", "rw"]);
export type SpaceFolderMode = Static<typeof SpaceFolderMode>;

export const SpaceLinkKind = StringEnum(["url", "library_item", "note", "mail_thread", "file"], {
  $id: "SpaceLinkKind",
});
export type SpaceLinkKind = Static<typeof SpaceLinkKind>;

export const SpaceLinkProvenance = StringEnum(["owner", "agent", "untrusted"], {
  $id: "SpaceLinkProvenance",
});

export const SpaceTrackerKind = StringEnum(["bound", "query", "agent"], {
  $id: "SpaceTrackerKind",
});
export type SpaceTrackerKind = Static<typeof SpaceTrackerKind>;

/** Templates in the shelf's Add menu; all are query trackers built by code (§6.1). */
export const SpaceTrackerTemplate = StringEnum(
  ["work_due", "next_events", "recent_files", "mail_on_this", "checklist", "automation_status"],
  { $id: "SpaceTrackerTemplate" },
);
export type SpaceTrackerTemplate = Static<typeof SpaceTrackerTemplate>;

export const SpaceFolder = Type.Object(
  {
    path: Type.String(),
    real: Type.String({ description: "The real path recorded when the folder was added" }),
    mode: SpaceFolderMode,
    automationsWrite: Type.Boolean({
      description: "Unattended runs (automations) may write here (SP8); default false",
    }),
    addedAt: IsoDateTime,
    addedByDevice: Nullable(Id),
  },
  { $id: "SpaceFolder", ...Strict },
);
export type SpaceFolder = Static<typeof SpaceFolder>;

export const SpaceLink = Type.Object(
  {
    id: Id,
    kind: SpaceLinkKind,
    ref: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1, maxLength: SPACE_LIMITS.linkLabel }),
    labelProvenance: SpaceLinkProvenance,
    addedBy: StringEnum(["owner", "agent"]),
    createdAt: IsoDateTime,
  },
  { $id: "SpaceLink", ...Strict },
);
export type SpaceLink = Static<typeof SpaceLink>;

export const SpaceTracker = Type.Object(
  {
    widgetId: Id,
    position: Type.Integer({ minimum: 0 }),
    kind: SpaceTrackerKind,
    staleAfterS: Nullable(Type.Integer({ minimum: 1 })),
    refreshedAt: Nullable(IsoDateTime),
    addedBy: StringEnum(["owner", "agent", "template"]),
    createdAt: IsoDateTime,
    taint: Type.Optional(Type.Array(TaintSource)),
  },
  { $id: "SpaceTracker", ...Strict },
);
export type SpaceTracker = Static<typeof SpaceTracker>;

export const SpaceCounts = Type.Object(
  {
    chats: Type.Integer({ minimum: 0 }),
    trackers: Type.Integer({ minimum: 0 }),
    due: Type.Integer({ minimum: 0 }),
  },
  { $id: "SpaceCounts", ...Strict },
);
export type SpaceCounts = Static<typeof SpaceCounts>;

/** One row of `spaces.list`. */
export const SpaceSummary = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1, maxLength: SPACE_LIMITS.name }),
    description: Nullable(Type.String({ maxLength: SPACE_LIMITS.description })),
    icon: Nullable(Type.String()),
    entityId: Nullable(Id),
    private: Type.Boolean(),
    sort: Type.Integer(),
    archivedAt: Nullable(IsoDateTime),
    counts: SpaceCounts,
    lastActivityAt: Nullable(IsoDateTime),
  },
  { $id: "SpaceSummary", ...Strict },
);
export type SpaceSummary = Static<typeof SpaceSummary>;

export const Space = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1, maxLength: SPACE_LIMITS.name }),
    description: Nullable(Type.String({ maxLength: SPACE_LIMITS.description })),
    icon: Nullable(Type.String()),
    instructions: Type.String({ maxLength: SPACE_LIMITS.instructions }),
    instructionsRev: Type.Integer({ minimum: 1 }),
    entityId: Nullable(Id),
    defaultPermissionMode: Nullable(PermissionMode),
    connectorScope: Nullable(Type.Array(Type.String())),
    private: Type.Boolean(),
    sort: Type.Integer(),
    archivedAt: Nullable(IsoDateTime),
    createdFrom: SpaceCreatedFrom,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "Space", ...Strict },
);
export type Space = Static<typeof Space>;

/** `spaces.get`: the Space with its parts. */
export const SpaceDetail = Type.Object(
  {
    space: Space,
    folders: Type.Array(SpaceFolder),
    links: Type.Array(SpaceLink),
    trackers: Type.Array(SpaceTracker),
    automationIds: Type.Array(Id),
    goalIds: Type.Array(Id),
    counts: SpaceCounts,
    lastActivityAt: Nullable(IsoDateTime),
  },
  { $id: "SpaceDetail", ...Strict },
);
export type SpaceDetail = Static<typeof SpaceDetail>;

export const SpaceProposalStatus = StringEnum(["open", "accepted", "dismissed"], {
  $id: "SpaceProposalStatus",
});

export const SpaceProposal = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1, maxLength: SPACE_LIMITS.name }),
    reason: Type.String(),
    entityId: Nullable(Id),
    threadIds: Type.Array(Id),
    taint: Type.Array(TaintSource),
    status: SpaceProposalStatus,
    createdAt: IsoDateTime,
    decidedAt: Nullable(IsoDateTime),
  },
  { $id: "SpaceProposal", ...Strict },
);
export type SpaceProposal = Static<typeof SpaceProposal>;

/** One project the migration offer lists (§8): what it would bring into a Space. */
export const SpaceMigrationProject = Type.Object(
  {
    entityId: Id,
    name: Type.String(),
    anchors: Type.Integer({ minimum: 0 }),
    threads: Type.Integer({ minimum: 0 }),
    folders: Type.Integer({
      minimum: 0,
      description: 'Listed in the Space as "shared everywhere"',
    }),
  },
  { $id: "SpaceMigrationProject", ...Strict },
);
export type SpaceMigrationProject = Static<typeof SpaceMigrationProject>;

/** "Make Spaces for your projects?" (§8, SP12): up to 5 projects, shown until decided. */
export const SpaceMigrationOffer = Type.Object(
  { projects: Type.Array(SpaceMigrationProject, { maxItems: 5 }) },
  { $id: "SpaceMigrationOffer", ...Strict },
);
export type SpaceMigrationOffer = Static<typeof SpaceMigrationOffer>;

/** Offers on a Space page after a chat moved in (§8). Nothing here is applied without a tap. */
export const SpaceOfferWidget = Type.Object(
  {
    id: Type.String({ description: "Dismiss key" }),
    widgetId: Id,
    title: Type.String(),
    fromThreadId: Id,
  },
  { $id: "SpaceOfferWidget", ...Strict },
);
export const SpaceOfferRule = Type.Object(
  {
    id: Type.String({ description: "The pin id, also the dismiss key" }),
    text: Type.String({ maxLength: 500 }),
    fromThreadId: Id,
    fromThreadTitle: Type.String(),
  },
  { $id: "SpaceOfferRule", ...Strict },
);
export const SpaceOffers = Type.Object(
  { widgets: Type.Array(SpaceOfferWidget), rules: Type.Array(SpaceOfferRule) },
  { $id: "SpaceOffers", ...Strict },
);
export type SpaceOffers = Static<typeof SpaceOffers>;

/** A refreshed query tracker value (`spaces.open`, `spaces.trackers.refresh`). */
export const SpaceTrackerValue = Type.Object(
  {
    widgetId: Id,
    refreshedAt: IsoDateTime,
    stale: Type.Boolean(),
    unavailable: Type.Optional(Type.Boolean({ description: "The source is gone" })),
    source: Type.Optional(
      Type.String({ description: 'e.g. "mail", for "Updated 2h ago · from mail"' }),
    ),
  },
  { $id: "SpaceTrackerValue", ...Strict },
);
export type SpaceTrackerValue = Static<typeof SpaceTrackerValue>;

/** `spaces.context.preview`: what a run in this Space would get (§5.2). */
export const SpaceContextSection = Type.Object(
  {
    kind: StringEnum(["instructions", "card", "work", "trackers"]),
    text: Type.String(),
    chars: Type.Integer({ minimum: 0 }),
    cap: Type.Integer({ minimum: 0 }),
  },
  { $id: "SpaceContextSection", ...Strict },
);
export type SpaceContextSection = Static<typeof SpaceContextSection>;
