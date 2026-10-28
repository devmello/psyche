import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTime, Nullable, Sha256, StringEnum } from "../common.ts";
import { AuditEntry } from "../schemas/permissions.ts";
import { defineMethod } from "./define.ts";

/**
 * `audit.*`: read-only access to the hash-chained audit log (architecture §4.12, data model §5,
 * security §15.1). Shapes follow the handlers in `@psyche/permissions` (S05), which the Gateway
 * mounts; entries are already redacted (no secrets, no bodies).
 */

export const AuditVerifyResult = Type.Object(
  {
    ok: Type.Boolean(),
    count: Type.Optional(Type.Integer({ minimum: 0 })),
    anchors: Type.Optional(Type.Integer({ minimum: 0 })),
    lastHash: Type.Optional(Sha256),
    brokenAtSeq: Type.Optional(Type.Integer({ minimum: 0 })),
    reason: Type.Optional(
      StringEnum([
        "hash_mismatch",
        "prev_mismatch",
        "seq_gap",
        "unparsable",
        "truncated",
        "anchor_mismatch",
        "anchor_missing",
        "anchor_signature",
      ]),
    ),
    file: Type.Optional(Type.String()),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Anchors whose signature was checked against an enrolled anchor key. */
    signedAnchors: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Key ids of the anchor keys that signed them. */
    anchorKeyIds: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 64 })),
    /** First entry seq whose anchor boundary must be signed (signing was enrolled then). */
    signingSinceSeq: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { $id: "AuditVerifyResult" },
);

const Count = Type.Integer({ minimum: 0 });
const Rate = Type.Number({ minimum: 0, maximum: 1 });
const Millis = Nullable(Type.Number({ minimum: 0 }));
const Counts = Type.Record(Type.String(), Count);

/** Per approval kind (`audit.friction`). */
export const AuditFrictionKind = Type.Object(
  {
    kind: Type.String(),
    decisions: Count,
    asks: Count,
    allows: Count,
    denies: Count,
    approved: Count,
    declined: Count,
    expired: Count,
    invalidated: Count,
    p50AnswerMs: Millis,
    p90AnswerMs: Millis,
  },
  { $id: "AuditFrictionKind" },
);

/**
 * Approval-friction metrics (S05 `frictionMetrics`): computed from decision, approval, grant and
 * classifier entries only, never from arguments.
 */
export const AuditFrictionResult = Type.Object(
  {
    from: Nullable(IsoDateTime),
    to: Nullable(IsoDateTime),
    decisions: Count,
    asks: Count,
    askRate: Rate,
    asksPerAskingRun: Type.Number({ minimum: 0 }),
    answerRate: Rate,
    approveRate: Rate,
    p50AnswerMs: Millis,
    p90AnswerMs: Millis,
    allowedByGrant: Count,
    grantsCreated: Counts,
    topAskRules: Type.Array(Type.Object({ rule: Type.String(), count: Count })),
    answerRejections: Counts,
    classifier: Counts,
    byKind: Type.Array(AuditFrictionKind),
    byMode: Type.Record(Type.String(), Type.Object({ decisions: Count, asks: Count })),
  },
  { $id: "AuditFrictionResult" },
);

const ExportFormat = StringEnum(["jsonl", "json"], { $id: "AuditExportFormat" });

export const AuditChangeCategory = StringEnum(
  ["file", "memory", "command", "connector", "skill", "setting", "approval"],
  { $id: "AuditChangeCategory" },
);

export const AuditChangeActor = Type.Object(
  {
    type: StringEnum(["agent", "job", "owner"]),
    /** The background job ("profile-learning", "dreaming") or the owner's surface. */
    name: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { $id: "AuditChangeActor" },
);

export const AuditChangeTarget = Type.Object(
  {
    path: Type.Optional(Type.String({ maxLength: 1000 })),
    connector: Type.Optional(Type.String({ maxLength: 100 })),
    object: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { $id: "AuditChangeTarget" },
);

/**
 * One owner-data change, read from a `change.recorded` audit entry (or an approval decision for
 * the `approval` category). The diff is fetched with `audit.change`.
 */
export const AuditChange = Type.Object(
  {
    seq: Type.Integer({ minimum: 0 }),
    hash: Sha256,
    ts: IsoDateTime,
    actor: AuditChangeActor,
    category: AuditChangeCategory,
    threadId: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    taskId: Type.Optional(Type.String()),
    toolCallId: Type.Optional(Type.String()),
    tool: Type.String(),
    target: AuditChangeTarget,
    action: Type.String(),
    approvalId: Type.Optional(Type.String()),
    receiptId: Type.Optional(Type.String()),
    beforeSha256: Type.Optional(Type.String()),
    afterSha256: Type.Optional(Type.String()),
    bytes: Type.Optional(Type.Integer({ minimum: 0 })),
    outcome: StringEnum(["ok", "failed"]),
    note: Type.Optional(Type.String()),
    hasDiff: Type.Boolean(),
    diffTruncated: Type.Optional(Type.Boolean()),
    stats: Type.Optional(
      Type.Object({ added: Type.Integer({ minimum: 0 }), removed: Type.Integer({ minimum: 0 }) }),
    ),
  },
  { $id: "AuditChange" },
);

export type AuditChange = Static<typeof AuditChange>;

const AuditChangesExportFormat = StringEnum(["json", "markdown"], {
  $id: "AuditChangesExportFormat",
});

const ChangeFilterProps = {
  threadId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  runId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  categories: Type.Optional(Type.Array(AuditChangeCategory, { maxItems: 8 })),
  since: Type.Optional(IsoDateTime),
  until: Type.Optional(IsoDateTime),
};

export const AuditMethods = {
  "audit.list": defineMethod({
    params: Type.Object({
      kind: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      kindPrefix: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 128,
          description: '"approval." matches every approval kind',
        }),
      ),
      taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      approvalId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      since: Type.Optional(IsoDateTime),
      until: Type.Optional(IsoDateTime),
      sinceSeq: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      order: Type.Optional(StringEnum(["asc", "desc"])),
    }),
    result: Type.Object({ entries: Type.Array(AuditEntry) }),
    scope: "operator.read",
    description:
      "Lists audit entries matching the filters (since inclusive, until exclusive). Page with sinceSeq.",
  }),
  "audit.changes": defineMethod({
    params: Type.Object({
      ...ChangeFilterProps,
      beforeSeq: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    result: Type.Object({ changes: Type.Array(AuditChange) }),
    scope: "operator.read",
    description:
      "Owner-data changes (files, memory, commands, connectors, skills, settings, approvals), newest first, from the audit log. Page with beforeSeq.",
  }),
  "audit.change": defineMethod({
    params: Type.Object({ seq: Type.Integer({ minimum: 0 }) }),
    result: Type.Object({
      change: AuditChange,
      /** Redacted unified diff; absent for binary or large files (hashes and size only). */
      diff: Type.Optional(Type.String()),
    }),
    scope: "operator.read",
    description: "One change with its stored unified diff.",
  }),
  "audit.changesExport": defineMethod({
    params: Type.Object({
      ...ChangeFilterProps,
      format: AuditChangesExportFormat,
    }),
    result: Type.Object({
      format: AuditChangesExportFormat,
      data: Type.String(),
      /** Chain status at export time. */
      verified: Type.Boolean(),
    }),
    scope: "operator.read",
    description: "Exports the matching changes with diffs and the chain status.",
  }),
  "audit.verify": defineMethod({
    params: Type.Object({}),
    result: AuditVerifyResult,
    scope: "operator.read",
    description: "Re-verifies the hash chain and anchors; reports the first broken entry.",
  }),
  "audit.export": defineMethod({
    params: Type.Object({
      format: Type.Optional(ExportFormat),
      since: Type.Optional(IsoDateTime),
      until: Type.Optional(IsoDateTime),
    }),
    result: Type.Object({ format: ExportFormat, data: Type.String() }),
    scope: "operator.admin",
    description:
      "Exports entries in a time window (default jsonl). Large logs: export a window at a time or use `psyche audit export`.",
  }),
  "audit.friction": defineMethod({
    params: Type.Object({
      since: Type.Optional(IsoDateTime),
      until: Type.Optional(IsoDateTime),
    }),
    result: AuditFrictionResult,
    scope: "operator.read",
    description:
      "Approval-friction metrics over a time window: ask and answer rates, answer latency, expiries, grant savings, per kind and mode.",
  }),
} as const;
