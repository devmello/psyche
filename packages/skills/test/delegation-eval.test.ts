import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FsSkillLoader } from "../src/loader.ts";
import { BUNDLED_DIR, OPEN_GATE, tempDir } from "./helpers.ts";

/**
 * Delegation eval (docs/agent/specialists-2026.md §4.8, §8 K): 30 labelled owner requests in
 * tests/scenarios/specialists/delegation.json, routed by a fixture delegator that applies the
 * "don't delegate" rules and then matches the request against each bundled role's
 * `description`, the text the main agent reads. Bar: 26 of 30. No model is called.
 */

interface Case {
  id: string;
  request: string;
  expect: string | null;
}
const data = JSON.parse(
  readFileSync(
    new URL("../../../tests/scenarios/specialists/delegation.json", import.meta.url),
    "utf8",
  ),
) as { cases: Case[] };

const STOP = new Set(
  "a an and are as at be by for from i in into is it its me my of on or our so that the their them these this to with you your can it's i'm want please get let".split(
    " ",
  ),
);

/** Lower-case word stems: plural and -ing / -ed folded, so "researching" meets "research". */
export function stems(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? [])
    .filter((w) => !STOP.has(w) && w.length > 2)
    .map((w) =>
      w
        .replace(/(ies)$/, "y")
        .replace(/(ing|ed)$/, "")
        .replace(/(es|s)$/, ""),
    );
}

/** §4.8 "don't delegate": sends, payments, deletes; back-and-forth; quick asks. */
function stayInThread(request: string): boolean {
  const r = request.toLowerCase();
  if (/^\s*(send|pay|buy|purchase|delete|remove|forward)\b/.test(r)) return true;
  if (/\b(let's|together|ask me|help me decide|with me)\b/.test(r)) return true;
  const words = r.split(/\s+/).filter(Boolean).length;
  return words <= 8 && /^\s*(what|when|who|where|remind|how many|is|are)\b/.test(r);
}

function delegate(request: string, roles: { role: string; description: string }[]): string | null {
  if (stayInThread(request)) return null;
  const want = new Set(stems(request));
  let best: { role: string; score: number } | null = null;
  for (const r of roles) {
    const have = new Set(stems(r.description));
    let score = 0;
    for (const w of want) if (have.has(w)) score += 1;
    if (best === null || score > best.score) best = { role: r.role, score };
  }
  return best !== null && best.score >= 2 ? best.role : null;
}

describe("specialist delegation eval (§4.8)", () => {
  it("routes at least 26 of the 30 scripted requests as labelled", async () => {
    const loader = new FsSkillLoader({
      homeDir: tempDir(),
      bundledDir: BUNDLED_DIR,
      gate: OPEN_GATE,
    });
    const roles = (await loader.specialistRoles()).map((r) => ({
      role: r.role.role,
      description: r.role.description,
    }));
    expect(roles.map((r) => r.role).sort()).toEqual([
      "coder",
      "organizer",
      "planner",
      "researcher",
      "shopper",
      "writer",
    ]);
    expect(data.cases).toHaveLength(30);
    const misses = data.cases
      .map((c) => ({ ...c, got: delegate(c.request, roles) }))
      .filter((c) => c.got !== c.expect);
    const score = data.cases.length - misses.length;
    if (process.env.PSYCHE_EVAL_LOG === "1")
      for (const m of misses)
        console.warn(`${m.id}: expected ${m.expect}, got ${m.got} — ${m.request}`);
    expect(score, misses.map((m) => `${m.id}→${m.got}`).join(", ")).toBeGreaterThanOrEqual(26);
  });
});
