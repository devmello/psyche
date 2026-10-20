import type { Goal } from "@psyche/protocol";
import { t } from "../../i18n/core.ts";
import { type EvidenceItem, readEvidence } from "../ideas/evidence.tsx";

/**
 * `Goal.plan` is untyped JSON (docs/status/s12.md gap 6). The kit reads this convention, which
 * the fixtures follow (src/fixtures/proactive.ts):
 *   { milestones: [{ title, done }], planArtifactId, notesMd, watches: [{ title, url, condition,
 *     lastValue }], checkins: [{ at, status, note }], evidence: [...] (candidates only) }
 */

export interface GoalMilestoneView {
  title: string;
  done: boolean;
  dueAt?: string | null;
}

export interface GoalWatch {
  title: string;
  url: string | null;
  condition: string | null;
  lastValue: string | null;
}

export interface GoalCheckin {
  at: string;
  status: string;
  note: string | null;
}

export interface GoalPlan {
  milestones: GoalMilestoneView[];
  planArtifactId: string | null;
  notesMd: string;
  watches: GoalWatch[];
  checkins: GoalCheckin[];
  evidence: EvidenceItem[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const objects = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
    : [];

export function readGoalPlan(goal: Goal): GoalPlan {
  const p = goal.plan ?? {};
  return {
    milestones: objects(p.milestones).flatMap((m) => {
      const title = str(m.title);
      return title === null ? [] : [{ title, done: m.done === true }];
    }),
    planArtifactId: str(p.planArtifactId),
    notesMd: str(p.notesMd) ?? "",
    watches: objects(p.watches).flatMap((w) => {
      const title = str(w.title);
      return title === null
        ? []
        : [
            {
              title,
              url: str(w.url),
              condition: str(w.condition),
              lastValue: str(w.lastValue),
            },
          ];
    }),
    checkins: objects(p.checkins)
      .flatMap((c) => {
        const at = str(c.at);
        return at === null
          ? []
          : [{ at, status: str(c.status) ?? "checked in", note: str(c.note) }];
      })
      .sort((a, b) => b.at.localeCompare(a.at)),
    evidence: readEvidence(p.evidence),
  };
}

export function milestoneProgress(milestones: readonly GoalMilestoneView[]): {
  done: number;
  total: number;
} {
  return { done: milestones.filter((m) => m.done).length, total: milestones.length };
}

export const GOAL_CATEGORY_LABEL: Record<Goal["category"], string> = {
  get health() {
    return t("screens.goals.category.health");
  },
  get finance() {
    return t("screens.goals.category.finance");
  },
  get career() {
    return t("screens.goals.category.career");
  },
  get relationships() {
    return t("screens.goals.category.relationships");
  },
  get productivity() {
    return t("screens.goals.category.productivity");
  },
  get learning() {
    return t("screens.goals.category.learning");
  },
  get home() {
    return t("screens.goals.category.home");
  },
  get other() {
    return t("screens.goals.category.other");
  },
};

export const GOAL_CATEGORY_ORDER: readonly Goal["category"][] = [
  "health",
  "finance",
  "career",
  "relationships",
  "productivity",
  "learning",
  "home",
  "other",
];
