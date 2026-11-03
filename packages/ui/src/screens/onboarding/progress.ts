import { ONBOARDING_STEP_IDS, type OnboardingStepId } from "./types.ts";

/** Setting that keeps a half-finished onboarding so it resumes where the owner quit. */
export const ONBOARDING_PROGRESS_KEY = "ui.onboarding.progress";

export interface OnboardingProgress {
  /** The step the owner was on. */
  step: OnboardingStepId;
  /** Steps finished or skipped on purpose; a re-run leaves these out. */
  done: OnboardingStepId[];
}

/**
 * Where a step of the old twelve-step flow lives now (docs/design/onboarding-2026.md §2), so
 * progress saved before the redesign resumes at the nearest step instead of at the start.
 */
const LEGACY: Readonly<Record<string, OnboardingStepId>> = {
  agent: "you",
  about: "you",
  permissions: "stuff",
  connectors: "stuff",
  mail: "stuff",
  sandbox: "model",
  where: "memory",
  wins: "memory",
  habits: "memory",
};

/** A saved or routed step id as a current step, or `null` when it is none. */
export function normalizeStep(id: unknown): OnboardingStepId | null {
  if (typeof id !== "string") return null;
  if ((ONBOARDING_STEP_IDS as readonly string[]).includes(id)) return id as OnboardingStepId;
  return LEGACY[id] ?? null;
}

export function parseProgress(value: unknown): OnboardingProgress | null {
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (raw === null || typeof raw !== "object") return null;
  const { step, done } = raw as { step?: unknown; done?: unknown };
  const current = normalizeStep(step);
  if (current === null) return null;
  const seen = new Set<OnboardingStepId>();
  if (Array.isArray(done))
    for (const d of done) {
      const id = normalizeStep(d);
      // A step counts as done only when the owner is past it.
      if (id !== null && ONBOARDING_STEP_IDS.indexOf(id) < ONBOARDING_STEP_IDS.indexOf(current))
        seen.add(id);
    }
  return { step: current, done: [...seen] };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
