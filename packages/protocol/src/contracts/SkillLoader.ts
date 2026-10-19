import type { JsonObject } from "../common.ts";

/**
 * Skill loader contract (architecture §13; feature T2; owner S16). Discovery order: workspace
 * `skills/` → `$PSYCHE_HOME/skills/` → bundled. Installing a third-party skill is a proposal:
 * the full text and a static scan are shown, and `install` needs an approved `skill_install`.
 * An approved skill never widens tool policy.
 */

export type SkillSource = "workspace" | "home" | "bundled";
export type SkillTrust = "bundled" | "verified" | "local" | "unknown";

export interface SkillSummary {
  name: string;
  description: string;
  source: SkillSource;
  path: string;
  trust: SkillTrust;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  enabled: boolean;
  hash: string;
}

export interface LoadedSkill extends SkillSummary {
  frontmatter: JsonObject;
  body: string;
}

export type SkillInstallSource =
  | { kind: "path"; path: string }
  | { kind: "git"; url: string; ref: string }
  | { kind: "zip"; path: string };

export interface ScanFinding {
  rule: string;
  severity: "info" | "warn" | "high";
  message: string;
  line?: number;
}

export interface SkillInstallProposal {
  id: string;
  name: string;
  source: SkillInstallSource;
  /** Full `SKILL.md` text, shown before enabling. */
  text: string;
  hash: string;
  trust: SkillTrust;
  findings: ScanFinding[];
  approvalKind: "skill_install";
}

export interface SkillLoader {
  list(): Promise<SkillSummary[]>;
  load(name: string): Promise<LoadedSkill | undefined>;
  search(query: string, limit?: number): Promise<SkillSummary[]>;
  proposeInstall(source: SkillInstallSource): Promise<SkillInstallProposal>;
  /** Rejects with `approval_required` without an approved `skill_install`. */
  install(proposalId: string, approvalId: string): Promise<SkillSummary>;
  remove(name: string): Promise<void>;
}
