import type { MethodResult } from "@psyche/protocol";

/** `usage.summary` fixtures (#599): an API-key week and a subscription (Claude Code) week. */

type UsageSummary = MethodResult<"usage.summary">;

const DATES = [
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
  "2026-10-15",
  "2026-10-16",
  "2026-10-17",
  "2026-10-18",
];

/** An API-key owner: $0.42 and 18k tokens today, a week of varying spend, no budget. */
export function usageSummary(): UsageSummary {
  const cost = [0.18, 0.31, 0.06, 0.52, 0.27, 0.12, 0.42];
  const tokens = [8_200, 14_100, 2_900, 23_400, 12_000, 5_600, 18_300];
  const turns = [6, 11, 2, 17, 9, 4, 12];
  return {
    days: DATES.map((date, i) => ({
      date,
      costUsd: cost[i] ?? 0,
      tokens: tokens[i] ?? 0,
      turns: turns[i] ?? 0,
    })),
    today: {
      costUsd: 0.42,
      tokens: 18_300,
      turns: 12,
      byModel: [
        {
          modelRef: "anthropic/claude-sonnet-5-5",
          subscription: false,
          costUsd: 0.39,
          tokens: 16_900,
          turns: 10,
        },
        {
          modelRef: "anthropic/claude-haiku-5-5",
          subscription: false,
          costUsd: 0.03,
          tokens: 1_400,
          turns: 2,
        },
      ],
    },
    byModel: [
      {
        modelRef: "anthropic/claude-sonnet-5-5",
        subscription: false,
        costUsd: 1.71,
        tokens: 76_200,
        turns: 52,
      },
      {
        modelRef: "anthropic/claude-haiku-5-5",
        subscription: false,
        costUsd: 0.17,
        tokens: 8_300,
        turns: 9,
      },
    ],
    month: { costUsd: 12.6, tokens: 512_000, turns: 341 },
    budgetUsd: null,
    primary: "anthropic/claude-sonnet-5-5",
    planWindow: null,
  };
}

/** A subscription owner on Claude Code: turns and tokens, no cost, no window by default. */
export function subscriptionUsageSummary(): UsageSummary {
  const tokens = [21_000, 34_000, 9_000, 41_000, 28_000, 12_000, 18_400];
  const turns = [8, 14, 3, 19, 11, 5, 12];
  return {
    days: DATES.map((date, i) => ({
      date,
      costUsd: 0,
      tokens: tokens[i] ?? 0,
      turns: turns[i] ?? 0,
    })),
    today: {
      costUsd: 0,
      tokens: 18_400,
      turns: 12,
      byModel: [
        {
          modelRef: "claude-code/sonnet",
          subscription: true,
          costUsd: 0,
          tokens: 18_400,
          turns: 12,
        },
      ],
    },
    byModel: [
      {
        modelRef: "claude-code/sonnet",
        subscription: true,
        costUsd: 0,
        tokens: 163_400,
        turns: 72,
      },
    ],
    month: { costUsd: 0, tokens: 640_000, turns: 290 },
    budgetUsd: null,
    primary: "claude-code/sonnet",
    planWindow: null,
  };
}
