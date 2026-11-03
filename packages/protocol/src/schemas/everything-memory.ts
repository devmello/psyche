import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, ModelRef, Nullable, Provenance, StringEnum } from "../common.ts";
import {
  EntitySummary,
  GraphCitation,
  GraphCitationSource,
  GraphFact,
  GraphFactAttribute,
  GraphReviewState,
  type GraphSensitivity,
} from "./graph.ts";

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
      {
        $id: "EverythingSourceSwitches",
        description:
          "Legacy: one switch per source, all off. Superseded by `optOut` (memory follows Search); the Gateway reads it only to migrate a value that has no `optOut`, and a UI keeps it equal to the sources memory learns from",
      },
    ),
    optOut: Type.Object(
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
      {
        $id: "EverythingSourceOptOut",
        description:
          "Per source: true means do not learn from it. Memory learns from every source Search indexes unless it is opted out here",
      },
    ),
    people: Type.Object(
      {
        default: EverythingPeopleDefault,
        aboutOthers: bool(
          false,
          "Keep what one person says about someone else (always pending); off: only what people say about themselves",
        ),
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
  optOut: {
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
  people: { default: "two_way", aboutOthers: false },
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

/**
 * The sources the nightly pass can read, in the order Search lists them. Browser pages and chats
 * with Psyche are in `EverythingSource` but are never read, whatever is switched on anywhere.
 */
export const EVERYTHING_READABLE_SOURCES = [
  "mail",
  "messages",
  "notes",
  "calendar",
  "reminders",
  "files",
  "transcripts",
] as const satisfies readonly EverythingSource[];
export type EverythingReadableSource = (typeof EVERYTHING_READABLE_SOURCES)[number];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Per source, whether the owner opted out of learning from it, read from a stored
 * `memory.everything` value (docs/design/everything-memory-2026.md §8: memory follows Search).
 * A value with `optOut` uses it. An older value has only the per-source switches: one that was
 * explicitly off becomes an opt-out and one that was on, or never stored, is not. Nothing here
 * widens what an older value let memory read: a source it switched off stays off.
 */
export function everythingOptOut(stored: unknown): Record<EverythingSource, boolean> {
  const value = isRecord(stored) ? stored : {};
  const out = { ...EVERYTHING_MEMORY_DEFAULTS.optOut } as Record<EverythingSource, boolean>;
  const current = value.optOut;
  const legacy = isRecord(value.sources) ? value.sources : undefined;
  for (const s of Object.keys(out) as EverythingSource[]) {
    out[s] = isRecord(current) ? current[s] === true : legacy?.[s] === false;
  }
  return out;
}

/**
 * The sources memory learns from: Search indexes them and the owner has not opted out.
 * Effective = indexed && !optOut. Browser pages and chats are never in it.
 */
export function effectiveEverythingSources(
  optOut: Readonly<Partial<Record<EverythingSource, boolean>>>,
  indexed: Iterable<string>,
): Record<EverythingSource, boolean> {
  const on = new Set(indexed);
  const out = { ...EVERYTHING_MEMORY_DEFAULTS.sources } as Record<EverythingSource, boolean>;
  for (const s of EVERYTHING_READABLE_SOURCES) out[s] = on.has(s) && optOut[s] !== true;
  return out;
}

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

// --- Exclusions (§10.1) -----------------------------------------------------------------------

export const EverythingExclusionMode = StringEnum(["exclude", "forget"], {
  $id: "EverythingExclusionMode",
  description: "exclude: read no text, learn nothing; forget: also delete what was learned",
});
export type EverythingExclusionMode = Static<typeof EverythingExclusionMode>;

/** One excluded address, number or domain. Only a masked hint is kept; the value is hashed. */
export const EverythingExclusion = Type.Object(
  {
    id: Type.String({ description: "Opaque; for memory.exclusions.remove" }),
    kind: StringEnum(["email", "phone", "domain"], { $id: "EverythingExclusionKind" }),
    hint: Nullable(Type.String({ maxLength: 200 })),
    mode: EverythingExclusionMode,
    createdAt: IsoDateTime,
  },
  { $id: "EverythingExclusion" },
);
export type EverythingExclusion = Static<typeof EverythingExclusion>;

// --- Run now (§6.1) -----------------------------------------------------------------------------

export const EverythingRunReason = StringEnum(
  [
    "disabled",
    "no_sources",
    "model_none",
    "battery",
    "low_power",
    "thermal",
    "not_idle",
    "outside_quiet_hours",
    "local_not_confirmed",
    "low_memory",
    "no_owner_entity",
    "store_unavailable",
    "busy",
  ],
  { $id: "EverythingRunReason", description: "Why a pass did not run" },
);
export type EverythingRunReason = Static<typeof EverythingRunReason>;

/** What "Run now" did: counts only, never text. */
export const EverythingRunResult = Type.Object(
  {
    ran: Type.Boolean(),
    reason: Nullable(EverythingRunReason),
    itemsRead: Type.Integer({ minimum: 0 }),
    factsProposed: Type.Integer({ minimum: 0 }),
    quarantined: Type.Integer({ minimum: 0 }),
    deferred: Type.Integer({ minimum: 0 }),
    tokens: Type.Integer({ minimum: 0 }),
  },
  { $id: "EverythingRunResult" },
);
export type EverythingRunResult = Static<typeof EverythingRunResult>;
// --- Per-sender auto-accept (§7.3) ------------------------------------------------------------

export const SenderTrustState = StringEnum(["offered", "trusted"], { $id: "SenderTrustState" });
export type SenderTrustState = Static<typeof SenderTrustState>;

/** A contact Psyche offers to auto-accept self-disclosures from, or already does. */
export const SenderTrust = Type.Object(
  {
    entityId: Id,
    name: Type.String({
      maxLength: 200,
      description: "A display name from a mail header: untrusted text",
    }),
    confirmed: Type.Integer({
      minimum: 0,
      description: "Facts the owner confirmed from them, none discarded",
    }),
    state: SenderTrustState,
  },
  { $id: "SenderTrust" },
);
export type SenderTrust = Static<typeof SenderTrust>;

export const SenderTrustDecision = StringEnum(["trust", "decline", "revoke"], {
  $id: "SenderTrustDecision",
});
export type SenderTrustDecision = Static<typeof SenderTrustDecision>;

// --- Coming up (§12.3, §12.5) -------------------------------------------------------------------

export const ComingUpKind = StringEnum(["birthday", "anniversary", "event"], {
  $id: "ComingUpKind",
});

export const ComingUpItem = Type.Object(
  {
    entityId: Id,
    name: Type.String({ maxLength: 200 }),
    kind: ComingUpKind,
    date: Type.String({
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Next occurrence, local date",
    }),
    daysAway: Type.Integer({ minimum: 0 }),
    turns: Nullable(Type.Integer({ minimum: 0 })),
    lastContactAt: Nullable(IsoDateTime),
    text: Type.String({
      maxLength: 400,
      description: "One plain line, built from names and dates",
    }),
  },
  { $id: "ComingUpItem" },
);
export type ComingUpItem = Static<typeof ComingUpItem>;

/** What forgetting or excluding a person would remove (or did), counts only. */
export const PersonRemoved = Type.Object(
  {
    facts: Type.Integer({ minimum: 0 }),
    edges: Type.Integer({ minimum: 0 }),
    citations: Type.Integer({ minimum: 0 }),
    quarantine: Type.Integer({ minimum: 0 }),
  },
  { $id: "PersonRemoved" },
);
export type PersonRemoved = Static<typeof PersonRemoved>;

// --- Life search (§12.4) -----------------------------------------------------------------------

export const LifeFactHit = Type.Object(
  {
    factId: Id,
    entity: EntitySummary,
    attribute: GraphFactAttribute,
    value: Type.String({
      maxLength: 2000,
      description: "Untrusted text when it came from someone else",
    }),
    provenance: Provenance,
    review: GraphReviewState,
    quote: Nullable(Type.String({ maxLength: 200 })),
    source: Nullable(Type.String({ maxLength: 40 })),
    observedAt: Nullable(IsoDateTime),
    learnedAt: Nullable(IsoDateTime),
  },
  { $id: "LifeFactHit" },
);
export type LifeFactHit = Static<typeof LifeFactHit>;

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
