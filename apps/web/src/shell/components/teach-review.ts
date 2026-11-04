import {
  type BrowserTeachStep,
  sanitizeTeachSteps,
  teachStepIssues,
  teachUrl,
} from "@psyche/protocol";
import type { TeachCapture, TeachCapturedStep } from "../platform.ts";

/**
 * The review screen's model (teach by showing, design doc §3): what Stop hands over, what the
 * owner can do to it, and what Save may send. Pure so the privacy rules are tested without a DOM.
 *
 * The example the owner typed (`sample`) lives only here. It is sent only when the owner chose
 * "Keep this value" for that step, and never for a sensitive step, which has no sample at all.
 */

export type ValueChoice = "ask" | "keep" | "input";

export interface ReviewStep {
  id: string;
  kind: TeachCapturedStep["kind"];
  url?: string;
  role?: string;
  name?: string;
  selector?: string;
  key?: string;
  sensitive: boolean;
  /** The example typed; absent when sensitive. In memory in this window only. */
  sample?: string;
  /** What to do with the typed value: ask each time (the default), keep it, or make it an input. */
  choice: ValueChoice;
  inputName: string;
  inputDescription: string;
}

export function reviewFrom(capture: TeachCapture): ReviewStep[] {
  const taken = new Set<string>();
  return capture.steps.map((s) => {
    const sensitive = s.sensitive === true;
    const step: ReviewStep = {
      id: s.id,
      kind: s.kind,
      sensitive,
      choice: "ask",
      inputName: "",
      inputDescription: "",
    };
    if (s.url !== undefined) step.url = s.url;
    if (s.role !== undefined) step.role = s.role;
    if (s.name !== undefined) step.name = s.name;
    if (s.selector !== undefined) step.selector = s.selector;
    if (s.key !== undefined) step.key = s.key;
    if (!sensitive && s.sample !== undefined) step.sample = s.sample;
    if (isTyped(step) && !sensitive) {
      step.inputName = suggestInputName(s.name, taken);
      taken.add(step.inputName);
    }
    return step;
  });
}

export const isTyped = (s: Pick<ReviewStep, "kind">): boolean =>
  s.kind === "type" || s.kind === "select";

/** `From date` becomes `from_date`; a name already taken gets `_2`. */
export function suggestInputName(name: string | undefined, taken: ReadonlySet<string>): string {
  const base =
    (name ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^[0-9]+/, "")
      .slice(0, 32)
      .replace(/_+$/, "") || "value";
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}_${n}`;
  return candidate;
}

export function moveStep(steps: readonly ReviewStep[], index: number, by: -1 | 1): ReviewStep[] {
  const to = index + by;
  if (index < 0 || index >= steps.length || to < 0 || to >= steps.length) return [...steps];
  const next = [...steps];
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

export function removeStep(steps: readonly ReviewStep[], index: number): ReviewStep[] {
  return steps.filter((_, i) => i !== index);
}

export function setChoice(
  steps: readonly ReviewStep[],
  index: number,
  choice: ValueChoice,
): ReviewStep[] {
  return steps.map((s, i) => {
    if (i !== index || s.sensitive || !isTyped(s)) return s;
    // "Keep" needs a value to keep.
    if (choice === "keep" && s.sample === undefined) return s;
    return { ...s, choice };
  });
}

export function patchStep(
  steps: readonly ReviewStep[],
  index: number,
  patch: Partial<Pick<ReviewStep, "inputName" | "inputDescription">>,
): ReviewStep[] {
  return steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
}

/** The steps Save sends: nothing the owner did not choose to keep, then cleaned once more. */
export function toSaveSteps(steps: readonly ReviewStep[]): BrowserTeachStep[] {
  const out: BrowserTeachStep[] = steps.map((s) => {
    const o: BrowserTeachStep = { id: s.id, kind: s.kind };
    if (s.url !== undefined) o.url = teachUrl(s.url);
    if (s.role !== undefined) o.role = s.role;
    if (s.name !== undefined) o.name = s.name;
    if (s.selector !== undefined) o.selector = s.selector;
    if (s.key !== undefined) o.key = s.key;
    if (s.sensitive) {
      o.sensitive = true;
      return o;
    }
    if (isTyped(s) && s.choice === "keep" && s.sample !== undefined) {
      o.keepValue = true;
      o.value = s.sample;
    }
    if (isTyped(s) && s.choice === "input") {
      o.input = { name: s.inputName.trim() };
      if (s.inputDescription.trim() !== "") o.input.description = s.inputDescription.trim();
    }
    return o;
  });
  return sanitizeTeachSteps(out);
}

/** A kept recording opened again: the steps as saved, with the values the owner kept. */
export function reviewFromKept(steps: readonly BrowserTeachStep[]): ReviewStep[] {
  return steps.map((s) => {
    const step: ReviewStep = {
      id: s.id,
      kind: s.kind,
      sensitive: s.sensitive === true,
      choice: "ask",
      inputName: "",
      inputDescription: "",
    };
    if (s.url !== undefined) step.url = s.url;
    if (s.role !== undefined) step.role = s.role;
    if (s.name !== undefined) step.name = s.name;
    if (s.selector !== undefined) step.selector = s.selector;
    if (s.key !== undefined) step.key = s.key;
    if (!step.sensitive && s.keepValue === true && s.value !== undefined) {
      step.choice = "keep";
      step.sample = s.value;
    }
    if (!step.sensitive && s.input !== undefined) {
      step.choice = "input";
      step.inputName = s.input.name;
      step.inputDescription = s.input.description ?? "";
    }
    return step;
  });
}

const INPUT_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** What stops Save, as short plain facts (the screen words them). Empty means it can be saved. */
export function reviewProblems(steps: readonly ReviewStep[]): string[] {
  const problems: string[] = [];
  for (const [i, s] of steps.entries())
    if (s.choice === "input" && !INPUT_NAME.test(s.inputName.trim()))
      problems.push(`step ${i + 1}: the input name uses lowercase letters, digits and _`);
  if (problems.length > 0) return problems;
  return teachStepIssues(toSaveSteps(steps));
}
