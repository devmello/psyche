import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, ModelRef, Nullable, StringEnum } from "../common.ts";
import { GraphCitation, GraphCitationSource, GraphFact, type GraphSensitivity } from "./graph.ts";

/**
 * Everything memory (docs/design/everything-memory-2026.md): settings (§8, §9, §10, §12.2),
 * review queue (§7), quarantine (§5.6) and nightly run log (§6.7). Settings are stored under
 * `memory.everything.*`; the root `memory` is not in the cosmetic allowlist, so every write
 * needs `operator.admin`, and the extractor principal never holds it (§5.2 D).
 */

/** Who reads the day (§8). `none` until the owner picks (decision 1). */
export const EverythingModelKind = StringEnum(["none", "cloud", "local"], {
  $id: "EverythingModelKind",
  description: "none: deterministic graph only; cloud: Haiku-class provider; local: on this Mac",
});
export type EverythingModelKind = Static<typeof EverythingModelKind>;

/** The sources a model can read, one switch each (decision D2). */
export const EverythingSource = StringEnum(
  [
    "mail",
    "messages",
    "notes",
    "calendar",
    "reminders",
    "chats",
    "files",
    "browser",
    "transcripts",
  ],
  { $id: "EverythingSource" },
);
export type EverythingSource = Static<typeof EverythingSource>;

/** A model choice. `ref` is only meaningful for `cloud` and `local`. */
export const EverythingProcessingModel = Type.Object(
  {
    kind: EverythingModelKind,
    ref: Type.Optional(ModelRef),
  },
  { $id: "EverythingProcessingModel" },
);
export type EverythingProcessingModel = Static<typeof EverythingProcessingModel>;

export const EverythingPeopleDefault = StringEnum(["two_way", "contacts", "everyone", "chosen"], {
  $id: "EverythingPeopleDefault",
});
export type EverythingPeopleDefault = Static<typeof EverythingPeopleDefault>;

export const EverythingAgentAccess = StringEnum(["none", "accepted", "all"], {
  $id: "EverythingAgentAccess",
});
export type EverythingAgentAccess = Static<typeof EverythingAgentAccess>;

/** The sensitive classes the owner can switch on; `gov_id` and `account_numbers` are not among them. */
export const EverythingSensitiveClass = StringEnum(
  [
    "health",
    "finance",
    "sexuality",
    "religion",
    "politics",
    "ethnicity",
    "legal",
    "precise_location",
  ],
  { $id: "EverythingSensitiveClass" },
);
export type EverythingSensitiveClass = Static<typeof EverythingSensitiveClass>;

const bool = (def: boolean, description?: string) => Type.Boolean({ default: def, description });

/**
 * `memory.everything` as a whole. Every field has a default (`EVERYTHING_MEMORY_DEFAULTS`), so a
 * missing key reads as the accepted decision from §14.
 */
export const EverythingMemorySettings = Type.Object(
  {
    enabled: bool(false, "Off by default for everyone, including after an update"),
    model: Type.Object(
      {
        default: EverythingProcessingModel,
        perSource: Type.Optional(
          Type.Partial(
            Type.Record(EverythingSource, EverythingProcessingModel, {
              description: "Later: a model per source (EM11); the UI arrives with it",
            }),
          ),
        ),
      },
      { $id: "EverythingModelSetting" },
    ),
    sources: Type.Object(
      {
        mail: bool(false),
        messages: bool(false),
        notes: bool(false),
        calendar: bool(false),
        reminders: bool(false),
        chats: bool(false),
        files: bool(false),
        browser: bool(false),
        transcripts: bool(false),
      },
      { $id: "EverythingSourceSwitches", description: "One switch per source, all off" },
    ),
    people: Type.Object(
      {
        default: EverythingPeopleDefault,
      },
      { $id: "EverythingPeopleSetting" },
    ),
    sensitive: Type.Object(
      {
        health: bool(false),
        finance: bool(false),
        sexuality: bool(false),
        religion: bool(false),
        politics: bool(false),
        ethnicity: bool(false),
        legal: bool(false),
        precise_location: bool(false),
      },
      {
        $id: "EverythingSensitiveSwitches",
        description:
          "All off. Only stated facts are stored when on. Government IDs and account numbers have no switch: they are never stored",
      },
    ),
    agentAccess: EverythingAgentAccess,
    agentSeesSensitive: bool(false, "Separate from the category switches"),
    review: Type.Object(
      {
        autoAcceptOwnerAuthored: bool(true, "Non-sensitive, confidence >= 0.8, no conflict"),
        autoAcceptSelfDisclosure: bool(false, "Offered, off by default (decision 6)"),
        perSenderAutoAcceptAfter: Type.Integer({
          minimum: 1,
          maximum: 50,
          default: 5,
          description: "Confirmed facts from one two-way contact before auto-accept is offered",
        }),
      },
      { $id: "EverythingReviewSetting" },
    ),
    schedule: Type.Object(
      {
        quietHoursStart: Type.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", default: "01:00" }),
        quietHoursEnd: Type.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", default: "06:00" }),
        runOnBattery: bool(false, "AC only by default (decision 10)"),
        backfillDays: StringEnum(["0", "30", "90", "365"], {
          $id: "EverythingBackfillDays",
          default: "30",
          description: "First-run backfill window in days (decision 7)",
        }),
      },
      { $id: "EverythingScheduleSetting" },
    ),
    retention: Type.Object(
      {
        pendingDays: Type.Integer({ minimum: 7, maximum: 90, default: 30 }),
        untrustedAcceptedMonths: Type.Integer({
          minimum: 0,
          maximum: 600,
          default: 24,
          description: "Months after newest evidence; 0 keeps them forever",
        }),
        quarantineDays: Type.Integer({ minimum: 7, maximum: 90, default: 30 }),
        runLogDays: Type.Integer({ minimum: 7, maximum: 365, default: 90 }),
      },
      { $id: "EverythingRetentionSetting" },
    ),
    maxTokensPerNight: Type.Integer({ minimum: 1000, default: 250000 }),
    writeCardFiles: bool(false, "Write person cards to files; off once everything memory is on"),
  },
  { $id: "EverythingMemorySettings" },
);
export type EverythingMemorySettings = Static<typeof EverythingMemorySettings>;

/** The accepted decisions of §14 as plain data; the Gateway reads missing keys from here. */
export const EVERYTHING_MEMORY_DEFAULTS = {
  enabled: false,
  model: { default: { kind: "none" } },
  sources: {
    mail: false,
    messages: false,
    notes: false,
    calendar: false,
    reminders: false,
    chats: false,
    files: false,
    browser: false,
    transcripts: false,
  },
  people: { default: "two_way" },
  sensitive: {
    health: false,
    finance: false,
    sexuality: false,
    religion: false,
    politics: false,
    ethnicity: false,
    legal: false,
    precise_location: false,
  },
  agentAccess: "accepted",
  agentSeesSensitive: false,
  review: {
    autoAcceptOwnerAuthored: true,
    autoAcceptSelfDisclosure: false,
    perSenderAutoAcceptAfter: 5,
  },
  schedule: {
    quietHoursStart: "01:00",
    quietHoursEnd: "06:00",
    runOnBattery: false,
    backfillDays: "30",
  },
  retention: {
    pendingDays: 30,
    untrustedAcceptedMonths: 24,
    quarantineDays: 30,
    runLogDays: 90,
  },
  maxTokensPerNight: 250000,
  writeCardFiles: false,
} as const satisfies EverythingMemorySettings;

export const EVERYTHING_MEMORY_SETTING_KEY = "memory.everything" as const;

/** Classes that are never stored, whatever the owner switches on (decision 5). */
export const HARD_BLOCKED_SENSITIVITY = [
  "gov_id",
  "account_numbers",
] as const satisfies readonly GraphSensitivity[];

// --- Review queue (§7) ------------------------------------------------------------------------

export const ReviewItemChange = StringEnum(["new", "changed", "conflict"], {
  $id: "ReviewItemChange",
  description: "changed: supersedes a value; conflict: a lower-ranked source disagrees",
});
export type ReviewItemChange = Static<typeof ReviewItemChange>;

export const ReviewItem = Type.Object(
  {
    fact: GraphFact,
    entityName: Type.String({ maxLength: 200 }),
    citations: Type.Array(GraphCitation, { maxItems: 10 }),
    change: ReviewItemChange,
    previousValue: Nullable(Type.String({ maxLength: 2000 })),
    sentence: Type.String({
      maxLength: 400,
      description: 'The fact as a sentence, e.g. "Ava\'s birthday is May 3"; untrusted text',
    }),
  },
  { $id: "ReviewItem" },
);
export type ReviewItem = Static<typeof ReviewItem>;

export const ReviewDecision = StringEnum(["confirm", "edit", "discard"], {
  $id: "ReviewDecision",
});
export type ReviewDecision = Static<typeof ReviewDecision>;

export const ReviewNever = StringEnum(["attribute_for_entity", "attribute_from_sender"], {
  $id: "ReviewNever",
  description: '"Never learn this": this attribute for this person, or from this sender',
});
export type ReviewNever = Static<typeof ReviewNever>;

// --- Quarantine (§5.6) ------------------------------------------------------------------------

export const QuarantineReason = StringEnum(
  [
    "instruction_like",
    "hidden_text",
    "claims_about_owner",
    "identity_claim",
    "relation_change",
    "too_many_claims",
    "sender_limit",
    "item_too_large",
    "schema_invalid",
    "new_sender_sensitive",
    "subject_mismatch",
  ],
  { $id: "QuarantineReason" },
);
export type QuarantineReason = Static<typeof QuarantineReason>;

export const QuarantineItem = Type.Object(
  {
    id: Id,
    source: GraphCitationSource,
    sourceRef: Type.String({ maxLength: 1024 }),
    senderEntityId: Nullable(Id),
    reasons: Type.Array(QuarantineReason, { minItems: 1, maxItems: 11 }),
    excerpt: Type.String({
      maxLength: 300,
      description: "Untrusted, truncated, never rendered as markup",
    }),
    createdAt: IsoDateTime,
    decided: Nullable(
      StringEnum(["released", "discarded", "blocked"], { $id: "QuarantineDecided" }),
    ),
    decidedAt: Nullable(IsoDateTime),
  },
  { $id: "QuarantineItem" },
);
export type QuarantineItem = Static<typeof QuarantineItem>;

export const QuarantineAction = StringEnum(["release", "discard", "block_sender"], {
  $id: "QuarantineAction",
});
export type QuarantineAction = Static<typeof QuarantineAction>;

// --- Runs (§6.7) ------------------------------------------------------------------------------

export const MemoryRun = Type.Object(
  {
    id: Id,
    startedAt: IsoDateTime,
    endedAt: Nullable(IsoDateTime),
    model: Nullable(ModelRef),
    sources: Type.Array(EverythingSource),
    itemsRead: Type.Integer({ minimum: 0 }),
    itemsFiltered: Type.Integer({ minimum: 0 }),
    batches: Type.Integer({ minimum: 0 }),
    tokensIn: Type.Integer({ minimum: 0 }),
    tokensOut: Type.Integer({ minimum: 0 }),
    factsProposed: Type.Integer({ minimum: 0 }),
    factsDropped: Type.Record(Type.String({ maxLength: 64 }), Type.Integer({ minimum: 0 }), {
      description: "Counts by drop reason; never text",
    }),
    quarantined: Type.Integer({ minimum: 0 }),
    deferred: Type.Integer({ minimum: 0 }),
    error: Nullable(Type.String({ maxLength: 500 })),
  },
  { $id: "MemoryRun" },
);
export type MemoryRun = Static<typeof MemoryRun>;
