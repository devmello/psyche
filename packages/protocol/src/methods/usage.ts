import { Type } from "@sinclair/typebox";
import { ModelRef, Nullable } from "../common.ts";
import {
  UsageByModel,
  UsageDay,
  UsagePlanWindow,
  UsageTally,
  UsageToday,
} from "../schemas/usage.ts";
import { defineMethod } from "./define.ts";

/**
 * `usage.*` (redesign #599): a light read over the run ledger for the sidebar's usage footer and
 * Settings → Usage.
 */
export const UsageMethods = {
  "usage.summary": defineMethod({
    params: Type.Object({
      /** Days in the window, today included (default 7). */
      days: Type.Optional(Type.Integer({ minimum: 1, maximum: 31 })),
      /** IANA time zone the days are counted in (default UTC). */
      timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    }),
    result: Type.Object({
      /** Oldest first, one entry per day of the window (zeros included). */
      days: Type.Array(UsageDay),
      today: UsageToday,
      /** The window's totals by model, most tokens first. */
      byModel: Type.Array(UsageByModel),
      /** This calendar month so far, in the time zone. */
      month: UsageTally,
      /** `usage.monthlyBudgetUsd`, when the owner set one. */
      budgetUsd: Nullable(Type.Number({ minimum: 0 })),
      /** The primary role's model, so a client knows which kind of usage to lead with. */
      primary: Nullable(ModelRef),
      /** The subscription window, when an adapter can read it; null otherwise (never estimated). */
      planWindow: Nullable(UsagePlanWindow),
    }),
    scope: "operator.read",
    description:
      "Tokens, cost and turns from the run ledger: one row per day of the window, today by model, the window by model, the month so far, the monthly budget setting and the plan window when known.",
  }),
} as const;
