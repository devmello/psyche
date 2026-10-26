import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTime, ModelRef } from "../common.ts";

/** Tokens, cost and turns for one model, a day or a window (redesign #599). */
export const UsageTally = Type.Object(
  {
    /** Input + output + reasoning tokens; cache reads are not counted. */
    tokens: Type.Integer({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
    /** Agent turns (runs). */
    turns: Type.Integer({ minimum: 0 }),
  },
  { $id: "UsageTally" },
);
export type UsageTally = Static<typeof UsageTally>;

export const UsageByModel = Type.Object(
  {
    modelRef: ModelRef,
    /** A subscription CLI (Claude Code, Codex): no per-token cost; the plan's window is the budget. */
    subscription: Type.Boolean(),
    tokens: Type.Integer({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
    turns: Type.Integer({ minimum: 0 }),
  },
  { $id: "UsageByModel" },
);
export type UsageByModel = Static<typeof UsageByModel>;

export const UsageDay = Type.Object(
  {
    /** `YYYY-MM-DD` in the requested time zone. */
    date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    tokens: Type.Integer({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
    turns: Type.Integer({ minimum: 0 }),
  },
  { $id: "UsageDay" },
);
export type UsageDay = Static<typeof UsageDay>;

/** A subscription plan's rate-limit window, when its adapter can read it. */
export const UsagePlanWindow = Type.Object(
  {
    modelRef: ModelRef,
    /** Share of the window used, 0–1. */
    usedFraction: Type.Number({ minimum: 0, maximum: 1 }),
    resetsAt: IsoDateTime,
  },
  { $id: "UsagePlanWindow" },
);
export type UsagePlanWindow = Static<typeof UsagePlanWindow>;

export const UsageToday = Type.Object(
  {
    tokens: Type.Integer({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
    turns: Type.Integer({ minimum: 0 }),
    byModel: Type.Array(UsageByModel),
  },
  { $id: "UsageToday" },
);
export type UsageToday = Static<typeof UsageToday>;
