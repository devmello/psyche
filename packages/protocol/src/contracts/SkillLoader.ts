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
  /** Path inside the skill folder. */
  file?: string;
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

/** A user-invocable skill as a composer slash command. */
export interface SkillCommand {
  /** `/inbox-triage` */
  command: string;
  name: string;
  description: string;
  source: SkillSource;
  trust: SkillTrust;
}

export interface PromptIndexOptions {
  /** Characters for the whole block (agent-core's `skillsIndex` budget is 8 000). */
  budgetChars?: number;
  /** Descriptions are cut to this many characters. */
  maxDescriptionChars?: number;
}

/** The `<available_skills>` block for the system prompt, with what fit and what was cut. */
export interface PromptIndex {
  text: string;
  included: string[];
  omitted: string[];
}

export interface SkillLoader {
  list(): Promise<SkillSummary[]>;
  load(name: string): Promise<LoadedSkill | undefined>;
  search(query: string, limit?: number): Promise<SkillSummary[]>;
  proposeInstall(source: SkillInstallSource): Promise<SkillInstallProposal>;
  /** Rejects with `approval_required` without an approved `skill_install`. */
  install(proposalId: string, approvalId: string): Promise<SkillSummary>;
  remove(name: string): Promise<void>;
  /**
   * Enabled, model-invocable skills as the system-prompt index: text escaped, trust marked, an
   * omission marker when the budget cuts skills.
   */
  promptIndex?(options?: PromptIndexOptions): Promise<PromptIndex>;
  /** Enabled user-invocable skills, sorted by name. */
  commands?(): Promise<SkillCommand[]>;
  /** Sets the owner's switch; `source` picks a shadowed copy. Rejects `not_found`. */
  setEnabled?(name: string, enabled: boolean, source?: SkillSource): Promise<SkillSummary>;
}
