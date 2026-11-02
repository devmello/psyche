import type { DailyBrief, FeedWidget } from "@psyche/protocol";

/**
 * Static Feed snapshots (generative-ui-2026 §8, D8) built from numbers and fixed labels the run
 * already has. Nothing here copies text that came from mail, messages or a page: a snapshot has
 * no taint to carry, so it must not hold anything that would need one.
 */

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The brief's shape at a glance: one tile per section, and the open items an evening carries over. */
export function dailySnapshot(brief: DailyBrief, route: string): FeedWidget {
  const tiles = brief.sections.map((s, i) => ({
    id: `s${i}`,
    type: "stat",
    label: s.title.slice(0, 80),
    value: s.unavailable === true ? "Not connected" : s.items.length,
    ...(s.unavailable === true ? { tone: "neutral" } : {}),
  }));
  const carry = brief.carryOver?.length ?? 0;
  if (brief.kind === "evening" && carry > 0) {
    tiles.push({ id: "carry", type: "stat", label: "To carry over", value: carry });
  }
  const total = brief.sections.reduce((n, s) => n + s.items.length, 0);
  return {
    taint: [],
    spec: {
      v: 1,
      title: brief.kind === "morning" ? "Your day" : "Wrap-up",
      fallbackText: `${brief.kind === "morning" ? "Your day" : "Wrap-up"} for ${brief.date}: ${plural(total, "item", "items")}`,
      root: {
        id: "root",
        type: "stack",
        gap: "sm",
        children: [
          ...(tiles.length === 0
            ? []
            : [
                { id: "counts", type: "grid", columns: Math.min(tiles.length, 4), children: tiles },
              ]),
          {
            id: "open",
            type: "button",
            label: brief.kind === "morning" ? "Open your day" : "Open the wrap-up",
            action: { kind: "open", route },
          },
        ],
      },
    },
  };
}

export interface RunOutcome {
  status: "done" | "no_reply" | "failed" | "cancelled" | "skipped";
  /** Whole seconds the run took, when both ends are known. */
  seconds?: number;
  /** Where "Open" goes: the run's chat, or the runs list. */
  route: string;
}

const STATUS: Record<
  RunOutcome["status"],
  { label: string; tone: "success" | "warning" | "danger" | "neutral" }
> = {
  done: { label: "Finished", tone: "success" },
  no_reply: { label: "Nothing to report", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "warning" },
  skipped: { label: "Skipped", tone: "neutral" },
};

/** An automation run's outcome: the status, how long it took, and a way to open the result. */
export function runSnapshot(run: RunOutcome): FeedWidget {
  const s = STATUS[run.status];
  return {
    taint: [],
    spec: {
      v: 1,
      title: "Automation run",
      fallbackText: `Automation run: ${s.label}`,
      root: {
        id: "root",
        type: "stack",
        gap: "sm",
        children: [
          { id: "status", type: "status", label: s.label, tone: s.tone },
          ...(run.seconds === undefined
            ? []
            : [{ id: "took", type: "stat", label: "Took", value: run.seconds, unit: "s" }]),
          {
            id: "open",
            type: "button",
            label: "Open the result",
            action: { kind: "open", route: run.route },
          },
        ],
      },
    },
  };
}
