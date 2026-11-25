import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { TaintSource } from "./permissions.ts";

/**
 * Fork a plan (docs/design/fork-a-plan-2026.md): the owner splits a chat into 2 to 4 options, one
 * hidden branch thread per option works each out read-only, and the Plans view compares the
 * checked reports side by side. Nothing here runs a tool; taking a plan goes through the Night
 * shift `staged_apply` approval.
 */
export const PlanForkStatus = StringEnum(
  ["running", "comparing", "ready", "taken", "dismissed", "expired", "cancelled", "failed"],
  { $id: "PlanForkStatus" },
);
export type PlanForkStatus = Static<typeof PlanForkStatus>;

export const PlanForkBranchStatus = StringEnum(
  ["queued", "running", "reported", "failed", "cancelled", "budget_stopped"],
  { $id: "PlanForkBranchStatus" },
);
export type PlanForkBranchStatus = Static<typeof PlanForkBranchStatus>;

/** The tool class a valid cite came from; set by the Gateway when it checks a report (§4.2). */
export const ForkCiteSource = StringEnum(
  ["memory", "mail", "calendar", "contacts", "messages", "web", "files"],
  { $id: "ForkCiteSource" },
);
export type ForkCiteSource = Static<typeof ForkCiteSource>;

/** `ref`: a Memory fact or person id, mail message id, event id or URL from that call's result. */
export const ForkCite = Type.Object(
  {
    callId: Type.String({ minLength: 1, maxLength: 80 }),
    ref: Type.String({ minLength: 1, maxLength: 500 }),
    /** Absent in what the model files; the Gateway fills it for each cite that checks out. */
    source: Type.Optional(ForkCiteSource),
  },
  { $id: "ForkCite" },
);
export type ForkCite = Static<typeof ForkCite>;

const ItemId = Type.String({ minLength: 1, maxLength: 40 });
const Cites = Type.Array(ForkCite, { maxItems: 8 });
/** `YYYY-MM-DD` or a full ISO date-time. */
const ForkDate = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}(T[0-9:.+\\-Z]+)?$", maxLength: 40 });
/** Set by the Gateway when every cite of an item was dropped: shown as "No source". */
const Unsourced = Type.Optional(Type.Boolean());

export const ForkStep = Type.Object(
  {
    id: ItemId,
    text: Type.String({ maxLength: 200 }),
    who: StringEnum(["psyche", "you"], { $id: "ForkStepWho" }),
    when: Type.Optional(ForkDate),
    /** A live staged item of this branch; the Gateway drops it otherwise. */
    stagedId: Type.Optional(Id),
  },
  { $id: "ForkStep" },
);
export type ForkStep = Static<typeof ForkStep>;

export const ForkCost = Type.Object(
  {
    id: ItemId,
    label: Type.String({ maxLength: 80 }),
    amount: Type.Number(),
    /** ISO 4217. No conversion across currencies. */
    currency: Type.String({ minLength: 3, maxLength: 3 }),
    period: StringEnum(["once", "month", "year"], { $id: "ForkCostPeriod" }),
    estimate: Type.Boolean(),
    basis: Type.Optional(Type.String({ maxLength: 200 })),
    cites: Cites,
    unsourced: Unsourced,
  },
  { $id: "ForkCost" },
);
export type ForkCost = Static<typeof ForkCost>;

export const ForkDateItem = Type.Object(
  {
    id: ItemId,
    label: Type.String({ maxLength: 80 }),
    date: ForkDate,
    kind: StringEnum(["deadline", "event", "milestone"], { $id: "ForkDateKind" }),
    estimate: Type.Boolean(),
    cites: Cites,
    unsourced: Unsourced,
  },
  { $id: "ForkDateItem" },
);
export type ForkDateItem = Static<typeof ForkDateItem>;

export const ForkPerson = Type.Object(
  {
    id: ItemId,
    /** Kept only when it resolves in Memory's people store. */
    personId: Type.Optional(Id),
    name: Type.String({ maxLength: 80 }),
    effect: Type.String({ maxLength: 200 }),
    cites: Cites,
    unsourced: Unsourced,
  },
  { $id: "ForkPerson" },
);
export type ForkPerson = Static<typeof ForkPerson>;

export const ForkTradeoff = Type.Object(
  {
    id: ItemId,
    gain: Type.Optional(Type.String({ maxLength: 160 })),
    giveUp: Type.String({ maxLength: 160 }),
    cites: Cites,
    unsourced: Unsourced,
  },
  { $id: "ForkTradeoff" },
);
export type ForkTradeoff = Static<typeof ForkTradeoff>;

export const ForkRisk = Type.Object(
  {
    id: ItemId,
    text: Type.String({ maxLength: 200 }),
    likelihood: StringEnum(["low", "medium", "high"], { $id: "ForkRiskLikelihood" }),
    cites: Cites,
    unsourced: Unsourced,
  },
  { $id: "ForkRisk" },
);
export type ForkRisk = Static<typeof ForkRisk>;

export const ForkOpenQuestion = Type.Object(
  { id: ItemId, text: Type.String({ maxLength: 200 }) },
  { $id: "ForkOpenQuestion" },
);
export type ForkOpenQuestion = Static<typeof ForkOpenQuestion>;

/**
 * What a branch files with `fork_report` (§4.1). Ids are unique within the report; a second call
 * is refused. The text is the model's and may echo untrusted content: render it as plain text.
 */
export const ForkReport = Type.Object(
  {
    summary: Type.String({ maxLength: 600 }),
    steps: Type.Array(ForkStep, { maxItems: 20 }),
    costs: Type.Array(ForkCost, { maxItems: 20 }),
    dates: Type.Array(ForkDateItem, { maxItems: 20 }),
    people: Type.Array(ForkPerson, { maxItems: 20 }),
    tradeoffs: Type.Array(ForkTradeoff, { maxItems: 12 }),
    risks: Type.Array(ForkRisk, { maxItems: 10 }),
    openQuestions: Type.Array(ForkOpenQuestion, { maxItems: 8 }),
  },
  { $id: "ForkReport" },
);
export type ForkReport = Static<typeof ForkReport>;

export const PlanComparisonDimension = StringEnum(
  ["cost", "dates", "people", "tradeoffs", "risks", "open"],
  { $id: "PlanComparisonDimension" },
);
export type PlanComparisonDimension = Static<typeof PlanComparisonDimension>;

export const PlanComparisonCell = Type.Object(
  {
    branchId: Id,
    itemIds: Type.Array(ItemId, { maxItems: 20 }),
    note: Type.Optional(Type.String({ maxLength: 160 })),
  },
  { $id: "PlanComparisonCell" },
);

export const PlanComparisonRow = Type.Object(
  {
    dimension: PlanComparisonDimension,
    label: Type.String({ maxLength: 80 }),
    cells: Type.Array(PlanComparisonCell, { maxItems: 4 }),
    differs: Type.Boolean(),
  },
  { $id: "PlanComparisonRow" },
);

export const PlanComparisonBetterIf = Type.Object(
  { branchId: Id, text: Type.String({ maxLength: 160 }) },
  { $id: "PlanComparisonBetterIf" },
);

/** The comparison pass's checked output (§4.3). It never carries a number the reports lack. */
export const PlanComparison = Type.Object(
  {
    headline: Type.String({ maxLength: 200 }),
    rows: Type.Array(PlanComparisonRow, { maxItems: 24 }),
    /** "Better if you want…", never "You should". */
    betterIf: Type.Array(PlanComparisonBetterIf, { maxItems: 4 }),
  },
  { $id: "PlanComparison" },
);
export type PlanComparison = Static<typeof PlanComparison>;

/** What a scrubbed read withheld for a caller that isn't the desktop shell (§4.4). */
export const PlanForkScrub = Type.Object(
  {
    /** Items withheld whole: "1 more on your Mac". */
    hiddenItems: Type.Integer({ minimum: 0 }),
    /** Summary, headline, notes and "Better if" are replaced: "Open on your Mac to read this". */
    textHidden: Type.Boolean(),
    /** Totals that include a hidden item: "Total on your Mac". */
    totalsHidden: Type.Boolean(),
  },
  { $id: "PlanForkScrub" },
);
export type PlanForkScrub = Static<typeof PlanForkScrub>;

export const PlanForkBranch = Type.Object(
  {
    id: Id,
    forkId: Id,
    /** 0 to 3. */
    ord: Type.Integer({ minimum: 0, maximum: 3 }),
    label: Type.String({ minLength: 1, maxLength: 40 }),
    premise: Type.String({ minLength: 1, maxLength: 280 }),
    /** The hidden `subagent` thread holding the parent's history up to the fork point. */
    threadId: Id,
    taskId: Nullable(Id),
    status: PlanForkBranchStatus,
    error: Nullable(Type.String({ maxLength: 300 })),
    /** The checked report, or null before one is filed. Scrubbed per §4.4 for remote viewers. */
    report: Nullable(ForkReport),
    /** The branch read Memory, Messages or Contacts through a tool (§4.4). */
    readOwnerOnly: Type.Boolean(),
    taint: Type.Boolean(),
    taintSources: Type.Array(TaintSource, { maxItems: 20 }),
    spentUsd: Type.Number({ minimum: 0 }),
    tokens: Type.Integer({ minimum: 0 }),
    scrub: Type.Optional(PlanForkScrub),
    startedAt: Nullable(IsoDateTime),
    finishedAt: Nullable(IsoDateTime),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "PlanForkBranch" },
);
export type PlanForkBranch = Static<typeof PlanForkBranch>;

export const PlanFork = Type.Object(
  {
    id: Id,
    threadId: Id,
    /** The message the fork hangs off; null if that message was deleted. */
    forkMessageId: Nullable(Id),
    status: PlanForkStatus,
    error: Nullable(Type.String({ maxLength: 300 })),
    budgetUsd: Type.Number({ minimum: 0 }),
    spentUsd: Type.Number({ minimum: 0 }),
    tokens: Type.Integer({ minimum: 0 }),
    comparison: Nullable(PlanComparison),
    takenBranchId: Nullable(Id),
    takeApprovalId: Nullable(Id),
    createdByDeviceId: Nullable(Id),
    expiresAt: Nullable(IsoDateTime),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    finishedAt: Nullable(IsoDateTime),
  },
  { $id: "PlanFork" },
);
export type PlanFork = Static<typeof PlanFork>;

/** One option the owner is weighing: a short label and the premise to assume. */
export const PlanForkOption = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 40 }),
    premise: Type.String({ minLength: 1, maxLength: 280 }),
  },
  { $id: "PlanForkOption" },
);
export type PlanForkOption = Static<typeof PlanForkOption>;

export const PlanForkUpdateBranch = Type.Object(
  {
    id: Id,
    status: PlanForkBranchStatus,
    /** The current step label, from `run.step`. */
    step: Type.Optional(Type.String({ maxLength: 120 })),
  },
  { $id: "PlanForkUpdateBranch" },
);

/** `planFork.updated`: ids and states only, never report text (§4.4, §7.2). */
export const PlanForkUpdate = Type.Object(
  {
    forkId: Id,
    threadId: Id,
    status: PlanForkStatus,
    branches: Type.Array(PlanForkUpdateBranch, { maxItems: 4 }),
    spentUsd: Type.Number({ minimum: 0 }),
  },
  { $id: "PlanForkUpdate" },
);
export type PlanForkUpdate = Static<typeof PlanForkUpdate>;

/**
 * Setting keys and defaults for Fork a plan (§9). The default budget is the owner's decision of
 * 2026-11-24: $1.00, adjustable from $0.10 to $5.00. None is a sealed security setting.
 */
export const FORK_BUDGET_USD_MIN = 0.1;
export const FORK_BUDGET_USD_MAX = 5;
export const FORK_SETTING_DEFAULTS = {
  "forks.budgetUsd": 1,
  "forks.expiryDays": 7,
  "forks.suggestOptions": true,
} as const;
export type ForkSettingKey = keyof typeof FORK_SETTING_DEFAULTS;
