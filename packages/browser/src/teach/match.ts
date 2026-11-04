/**
 * Does the page still have what a recorded step names? (teach by showing, design doc §6)
 *
 * Replay of a skill made from a recording stops and asks when the page changed, instead of
 * guessing. This is the deterministic part of that: a recorded target (accessibility role and
 * name) is looked up in the live page. Exactly one match is `found`; none is `missing`; several is
 * `ambiguous`; a page on another origin is `wrong_page`. Anything but `found` has `stop: true`.
 * The match is exact on role and on the name (ignoring case and spacing): a similar-looking
 * element is not the same element, and the safe answer to "not sure" is to ask the owner.
 */

export interface TargetWant {
  /** The accessibility role the owner clicked or typed into; unchecked when absent. */
  role?: string;
  name: string;
  /** The origin the step was recorded on; a different page is `wrong_page`. */
  origin?: string;
}

export interface TargetCandidate {
  ref: string;
  role: string;
  name: string;
}

export type TargetCheck =
  | { status: "found"; stop: false; ref: string; role: string; name: string }
  | { status: "ambiguous"; stop: true; candidates: TargetCandidate[] }
  | { status: "missing"; stop: true }
  | { status: "wrong_page"; stop: true; expected: string; actual: string };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function matchRecordedTarget(
  candidates: readonly TargetCandidate[],
  want: TargetWant,
  actualOrigin?: string,
): TargetCheck {
  if (want.origin !== undefined && actualOrigin !== undefined && want.origin !== actualOrigin)
    return { status: "wrong_page", stop: true, expected: want.origin, actual: actualOrigin };
  const name = norm(want.name);
  const hits = candidates.filter(
    (c) => norm(c.name) === name && (want.role === undefined || norm(c.role) === norm(want.role)),
  );
  const [only] = hits;
  if (hits.length === 1 && only !== undefined)
    return { status: "found", stop: false, ref: only.ref, role: only.role, name: only.name };
  if (hits.length === 0) return { status: "missing", stop: true };
  return {
    status: "ambiguous",
    stop: true,
    candidates: hits.slice(0, 5).map((c) => ({ ref: c.ref, role: c.role, name: c.name })),
  };
}
