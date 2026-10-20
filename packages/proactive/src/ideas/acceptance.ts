/**
 * The acceptance model (feature O7; ADR-012 "gated by a learned acceptance probability"): a
 * logistic regression over a few idea features, refit from the accept / dismiss history before
 * every delivery window. With no history every idea scores the prior (0.5); after the owner
 * dismisses a kind of idea a few times, new ones of that kind fall under the delivery threshold.
 *
 * Labels and weights per decided idea:
 *
 * | outcome                  | label | weight |
 * | ------------------------ | ----- | ------ |
 * | accepted / edited        | 1     | 1.0    |
 * | dismissed not_interested | 0     | 1.0    |
 * | dismissed never_from_source | 0  | 1.0    |
 * | dismissed not_now        | 0     | 0.3    |
 * | expired after delivery   | 0     | 0.2    |
 */

export interface IdeaFeatures {
  kind: string;
  source: string;
  /** Minutes of estimated effort. */
  effortMinutes: number;
  evidenceCount: number;
}

export interface TrainingExample {
  features: IdeaFeatures;
  label: 0 | 1;
  weight: number;
}

export const PRIOR = 0.5;
const ITERATIONS = 300;
const LEARNING_RATE = 0.5;
const L2 = 0.02;

function vectorize(f: IdeaFeatures): Map<string, number> {
  const v = new Map<string, number>();
  v.set("bias", 1);
  v.set(`kind:${f.kind}`, 1);
  // The source family (`connector:gmail` → `connector`) and the exact source.
  v.set(`source:${f.source}`, 1);
  const family = f.source.split(":")[0] ?? f.source;
  if (family !== f.source) v.set(`family:${family}`, 1);
  v.set("effort", Math.min(1, Math.log1p(f.effortMinutes) / Math.log1p(240)));
  v.set("evidence", Math.min(1, Math.log1p(f.evidenceCount) / Math.log1p(10)));
  return v;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface AcceptanceModel {
  predict(features: IdeaFeatures): number;
  /** Examples the model was fit on. */
  readonly size: number;
}

/** Fits by batch gradient descent with L2 (deterministic: same history → same weights). */
export function fitAcceptanceModel(examples: readonly TrainingExample[]): AcceptanceModel {
  const w = new Map<string, number>();
  if (examples.length === 0) {
    return { predict: () => PRIOR, size: 0 };
  }
  const xs = examples.map((e) => vectorize(e.features));
  const total = examples.reduce((s, e) => s + e.weight, 0) || 1;
  for (let it = 0; it < ITERATIONS; it += 1) {
    const grad = new Map<string, number>();
    examples.forEach((e, i) => {
      const x = xs[i] as Map<string, number>;
      let z = 0;
      for (const [k, val] of x) z += (w.get(k) ?? 0) * val;
      const err = (sigmoid(z) - e.label) * e.weight;
      for (const [k, val] of x) grad.set(k, (grad.get(k) ?? 0) + err * val);
    });
    for (const [k, g] of grad) {
      const cur = w.get(k) ?? 0;
      const reg = k === "bias" ? 0 : L2 * cur;
      w.set(k, cur - LEARNING_RATE * (g / total + reg));
    }
  }
  return {
    size: examples.length,
    predict(features) {
      let z = 0;
      for (const [k, val] of vectorize(features)) z += (w.get(k) ?? 0) * val;
      return Math.round(sigmoid(z) * 1000) / 1000;
    },
  };
}

/** `"~10 min"`, `"~1 h"` → minutes; unknown → 15. */
export function effortMinutes(effort: string): number {
  const m = /(\d+(?:\.\d+)?)\s*(min|m|h|hour)/i.exec(effort);
  if (m === null) return 15;
  const n = Number(m[1]);
  return /^h/i.test(m[2] ?? "") ? n * 60 : n;
}
