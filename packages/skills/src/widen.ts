import type { SkillManifest } from "./manifest.ts";

/** What a new version asks for that the installed one did not (empty lists: nothing). */
export interface Widened {
  tools: string[];
  permissions: string[];
  prompts: string[];
  /** Plain-text ways the background role got wider. */
  specialist?: string[];
}

const MODE_ORDER = ["plan", "manual", "balanced", "auto"];

const added = (x: readonly string[], y: readonly string[]) => x.filter((v) => !y.includes(v));

function widenedSpecialist(
  b: SkillManifest["specialist"],
  a: SkillManifest["specialist"],
): string[] {
  if (a === undefined) return [];
  if (b === undefined) return [`adds the background role ${a.role}`];
  const out: string[] = [];
  if (a.role !== b.role) out.push(`the role id changes from ${b.role} to ${a.role}`);
  const newTools = added(a.tools, b.tools);
  if (newTools.length > 0) out.push(`the role can use ${newTools.join(", ")}`);
  const dropped = added(b.deny, a.deny);
  if (dropped.length > 0) out.push(`the role may now use ${dropped.join(", ")}`);
  const newApprovals = added(a.approvals, b.approvals);
  if (newApprovals.length > 0) out.push(`the role may ask for ${newApprovals.join(", ")}`);
  if (MODE_ORDER.indexOf(a.maxMode) > MODE_ORDER.indexOf(b.maxMode))
    out.push(`the role's highest mode goes from ${b.maxMode} to ${a.maxMode}`);
  for (const [field, x, y] of [
    ["budget", a.budget, b.budget],
    ["caps", a.caps, b.caps],
  ] as const) {
    for (const [k, v] of Object.entries(x)) {
      const old = y[k];
      if (old === undefined || v > old) out.push(`the role's ${field} ${k} grows`);
    }
  }
  if (b.planFirst && !a.planFirst) out.push("the role no longer plans first");
  if (b.memory === "none" && a.memory === "user") out.push("the role reads your memory");
  if (a.model !== b.model) out.push(`the role's model class changes to ${a.model}`);
  return out;
}

/**
 * What `after` asks for that `before` did not: new tools, approval kinds or prompt files, and a
 * wider background role (a new role, more tools, fewer denials, a higher mode, bigger budgets or
 * caps, more approval kinds, no plan-first, memory turned on). `undefined` when nothing is wider.
 * A broader tool glob replacing a narrow one is a new entry, so it shows up.
 */
export function widenedBy(
  before: SkillManifest | undefined,
  after: SkillManifest,
): Widened | undefined {
  const out: Widened = {
    tools: added(after.tools, before?.tools ?? []),
    permissions: added(after.permissions, before?.permissions ?? []),
    prompts: added(after.prompts, before?.prompts ?? []),
  };
  const specialist = widenedSpecialist(before?.specialist, after.specialist);
  if (specialist.length > 0) out.specialist = specialist;
  return out.tools.length + out.permissions.length + out.prompts.length + specialist.length === 0
    ? undefined
    : out;
}
