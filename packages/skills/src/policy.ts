import type { SkillManifest } from "./manifest.ts";

/**
 * Install policy for skills (feature T2, security §11): what a skill's manifest may ask for.
 * A proposal whose manifest asks for more is refused with `policy_denied` before any approval
 * card exists, and an installed skill that no longer fits (the owner tightened the policy) is
 * `blocked`. This never widens anything: an allowed manifest still gets no grant.
 */
export interface SkillInstallPolicy {
  /**
   * Approval kinds no skill may declare. Default `SKILL_FORBIDDEN_PERMISSIONS`: running on the
   * host, installing more skills, changing permissions, pairing devices, editing protected memory.
   */
  forbiddenPermissions?: readonly string[];
  /** Tool globs the owner denies outright (the broker policy's tool-only `deny` rules). */
  deniedTools?: readonly string[];
}

export const SKILL_FORBIDDEN_PERMISSIONS: readonly string[] = [
  "exec_host",
  "skill_install",
  "policy_change",
  "pairing",
  "memory_protected_write",
];

/** Tools no skill may declare whatever the owner's policy says: skills never manage skills. */
export const SKILL_FORBIDDEN_TOOLS: readonly string[] = [
  "skills.install",
  "skills.proposeInstall",
  "skills.remove",
  "skills.setEnabled",
  "policy.*",
];

function globRe(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`);
}

/** Two tool globs overlap when either matches the other with its `*` read as a wildcard. */
function overlaps(declared: string, denied: string): boolean {
  const sample = (g: string) => g.replace(/\*/g, "x");
  return globRe(denied).test(sample(declared)) || globRe(declared).test(sample(denied));
}

/** Plain-text reasons the manifest exceeds the policy; empty when it fits. */
export function policyViolations(
  manifest: SkillManifest,
  policy: SkillInstallPolicy = {},
): string[] {
  const out: string[] = [];
  const forbidden = new Set(policy.forbiddenPermissions ?? SKILL_FORBIDDEN_PERMISSIONS);
  for (const p of manifest.permissions) {
    if (forbidden.has(p)) out.push(`asks for the ${p} permission, which skills may not use`);
  }
  const denied = [...SKILL_FORBIDDEN_TOOLS, ...(policy.deniedTools ?? [])];
  for (const t of manifest.tools) {
    const hit = denied.find((d) => overlaps(t, d));
    if (hit !== undefined) out.push(`declares the tool ${t}, which the policy denies (${hit})`);
  }
  return out;
}

/**
 * Tool-only `deny` rules from a broker policy (`"email.delete"`, `"mcp__*"`); rules with a
 * target (`exec(rm *)`, `origin:*.bank`) restrict calls, not tools, so they are skipped.
 */
export function deniedToolsFromPolicy(policy: { deny?: readonly string[] } | undefined): string[] {
  return (policy?.deny ?? [])
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && !r.includes("(") && !/^[a-z]+:/.test(r));
}
