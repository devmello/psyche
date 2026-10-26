import { Type } from "@sinclair/typebox";
import { IsoDateTime, Nullable } from "../common.ts";
import { InsightDay, InsightEntity, InsightTotals } from "../schemas/insights.ts";
import { GrowthWindow } from "../schemas/learning.ts";
import { defineMethod } from "./define.ts";

/**
 * `insights.*` (docs/design/agent-overview-2026.md §6.2): one read-only aggregate for the Overview
 * screen, computed with SQL from tables that already exist. No event of its own: clients refetch
 * on `run.*`, `approval.*`, `artifact.*`, `growth.updated` and `memory.graph.*`.
 */
export const InsightsMethods = {
  "insights.summary": defineMethod({
    params: Type.Object({
      window: GrowthWindow,
      /** IANA time zone the days are counted in (default UTC). */
      timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    }),
    result: Type.Object({
      window: GrowthWindow,
      range: Type.Object({ from: IsoDateTime, to: IsoDateTime }),
      /** The earliest run, approval, artifact or specialist job; null for a brand-new install. */
      firstActivityAt: Nullable(IsoDateTime),
      totals: InsightTotals,
      /** The period right before this one; null for `all`. */
      previous: Nullable(InsightTotals),
      /** Oldest first, zeros included: 7 or 30 days, or for `all` the last 53 weeks (371 days). */
      days: Type.Array(InsightDay, { maxItems: 371 }),
      /** Most interactions in the window first; at most 12. */
      topEntities: Type.Array(InsightEntity, { maxItems: 12 }),
    }),
    scope: "operator.read",
    description:
      "Aggregates for the Overview: run, approval, artifact and specialist totals for a window with the previous period, one row per day, and the people and projects Psyche dealt with most.",
  }),
} as const;
