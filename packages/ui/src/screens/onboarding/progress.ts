import type { OnboardingStepId } from "./types.ts";

/** Setting that keeps a half-finished onboarding so it resumes where the owner quit. */
export const ONBOARDING_PROGRESS_KEY = "ui.onboarding.progress";

export interface OnboardingProgress {
  /** The step the owner was on. */
  step: OnboardingStepId;
  /** Steps finished or skipped on purpose; a re-run leaves these out. */
  done: OnboardingStepId[];
}

export function parseProgress(value: unknown): OnboardingProgress | null {
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (raw === null || typeof raw !== "object") return null;
  const { step, done } = raw as { step?: unknown; done?: unknown };
  if (typeof step !== "string") return null;
  return {
    step: step as OnboardingStepId,
    done: Array.isArray(done)
      ? (done.filter((d) => typeof d === "string") as OnboardingStepId[])
      : [],
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
