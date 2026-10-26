import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable } from "../common.ts";
import { GraphEntityKind } from "./graph.ts";

/**
 * `insights.summary` (docs/design/agent-overview-2026.md §6.2): counts over the owner's own
 * activity for the Overview screen. Local only; incognito threads' runs are excluded.
 */

const Count = Type.Integer({ minimum: 0 });

export const InsightTotals = Type.Object(
  {
    runs: Type.Object({ task: Count, chat: Count, automation: Count, subagent: Count }),
    runsDone: Count,
    runsFailed: Count,
    /** Sum of measured run wall time (endedAt − startedAt). */
    wallMs: Count,
    approvals: Type.Object({ approved: Count, denied: Count, expired: Count }),
    artifacts: Type.Object({ created: Count, versions: Count, charts: Count }),
    specialists: Type.Object({ done: Count, partial: Count, failed: Count }),
    busiestDay: Nullable(Type.Object({ date: Type.String(), runs: Count })),
    topAutomation: Nullable(Type.Object({ automationId: Id, title: Type.String(), runs: Count })),
  },
  { $id: "InsightTotals" },
);
export type InsightTotals = Static<typeof InsightTotals>;

export const InsightDay = Type.Object(
  {
    /** `YYYY-MM-DD` in the requested time zone. */
    date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    runs: Type.Object({ task: Count, chat: Count, automation: Count }),
    failed: Count,
    wallMs: Count,
  },
  { $id: "InsightDay" },
);
export type InsightDay = Static<typeof InsightDay>;

export const InsightEntity = Type.Object(
  {
    entityId: Id,
    kind: GraphEntityKind,
    name: Type.String(),
    interactions: Count,
    lastInteractionAt: IsoDateTime,
    openLoops: Count,
  },
  { $id: "InsightEntity" },
);
export type InsightEntity = Static<typeof InsightEntity>;
