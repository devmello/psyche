import { ONBOARDING_STEP_IDS, type OnboardingStepId } from "./types.ts";

/** Setting that keeps a half-finished onboarding so it resumes where the owner quit. */
export const ONBOARDING_PROGRESS_KEY = "ui.onboarding.progress";

/**
 * What the owner typed on the You step, kept with the progress so quitting midway loses nothing.
 * Plain text only (names, a city, a line about work): never a key, token or recovery key.
 */
export interface OnboardingAnswers {
  persona?: {
    name?: string;
    creatureId?: string;
    creatureMode?: "bundled" | "describe";
    creatureDescription?: string;
    tagline?: string;
  };
  owner?: { name?: string; timeZone?: string; work?: string; city?: string };
}

export interface OnboardingProgress {
  /** The step the owner was on. */
  step: OnboardingStepId;
  /** Steps finished or skipped on purpose; a re-run leaves these out. */
  done: OnboardingStepId[];
  /** The You step's answers, restored when onboarding resumes. */
  answers?: OnboardingAnswers;
}

const MAX_ANSWER = 2000;

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, MAX_ANSWER) : undefined;
}

function pick<K extends string>(raw: unknown, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  if (raw === null || typeof raw !== "object") return out;
  for (const k of keys) {
    const v = text((raw as Record<string, unknown>)[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The saved answers as a defensive, string-only copy; undefined when there are none. */
export function parseAnswers(raw: unknown): OnboardingAnswers | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const { persona, owner } = raw as { persona?: unknown; owner?: unknown };
  const out: OnboardingAnswers = {};
  const p = pick(persona, ["name", "creatureId", "creatureMode", "creatureDescription", "tagline"]);
  if (p.creatureMode !== "bundled" && p.creatureMode !== "describe") delete p.creatureMode;
  if (Object.keys(p).length > 0) out.persona = p as NonNullable<OnboardingAnswers["persona"]>;
  const o = pick(owner, ["name", "timeZone", "work", "city"]);
  if (Object.keys(o).length > 0) out.owner = o;
  return out.persona || out.owner ? out : undefined;
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
  const { step, done, answers } = raw as { step?: unknown; done?: unknown; answers?: unknown };
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
  const saved = parseAnswers(answers);
  return { step: current, done: [...seen], ...(saved ? { answers: saved } : {}) };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
