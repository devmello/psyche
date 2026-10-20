import type {
  LoadedSkill,
  PromptIndex,
  PromptIndexOptions,
  ScanFinding,
  SkillCommand,
  SkillInstallProposal,
  SkillInstallSource,
  SkillLoader,
  SkillSource,
  SkillSummary,
  SkillUpdateCheck,
} from "@psyche/protocol";
import { sha256 } from "../canonical.ts";
import { createIdGenerator, type IdGenerator } from "../ids.ts";
import { fail } from "./errors.ts";

export interface FakeSkillInput {
  name: string;
  description: string;
  body: string;
  source?: SkillSource;
  userInvocable?: boolean;
}

const SOURCE_ORDER: SkillSource[] = ["workspace", "home", "bundled"];

/** Minimal static scan (S16 owns the real one). */
export function scanSkillText(text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  text.split("\n").forEach((line, i) => {
    if (/curl[^|\n]*\|\s*(ba)?sh/.test(line)) {
      findings.push({ rule: "pipe-to-shell", severity: "high", message: "curl | sh", line: i + 1 });
    }
    if (/\{\{cred:/.test(line)) {
      findings.push({
        rule: "placeholder",
        severity: "warn",
        message: "credential placeholder",
        line: i + 1,
      });
    }
  });
  return findings;
}

/**
 * In-memory skills. `add` registers skills by source (workspace shadows home shadows bundled);
 * `stageInstall(source, text)` defines what `proposeInstall` will find at a source; `install`
 * requires an approval id accepted by `isApproved` (default: non-empty). `promptIndex` is a
 * plain one-line-per-skill block (S16 owns the real escaping and wording).
 */
export class FakeSkillLoader implements SkillLoader {
  #skills: LoadedSkill[] = [];
  #staged = new Map<string, { name: string; text: string }>();
  #proposals = new Map<string, SkillInstallProposal>();
  /** Installed name → the source it came from (for `checkUpdates`). */
  #origins = new Map<string, SkillInstallSource>();
  #ids: IdGenerator;
  #isApproved: (approvalId: string) => boolean;

  constructor(options: { ids?: IdGenerator; isApproved?: (approvalId: string) => boolean } = {}) {
    this.#ids = options.ids ?? createIdGenerator();
    this.#isApproved = options.isApproved ?? ((id) => id.length > 0);
  }

  add(input: FakeSkillInput): this {
    const source = input.source ?? "workspace";
    this.#skills.push({
      name: input.name,
      description: input.description,
      source,
      path: `${source}/skills/${input.name}/SKILL.md`,
      trust: source === "bundled" ? "bundled" : "local",
      userInvocable: input.userInvocable ?? false,
      disableModelInvocation: false,
      enabled: true,
      hash: sha256(input.body),
      frontmatter: { name: input.name, description: input.description },
      body: input.body,
    });
    return this;
  }

  stageInstall(source: SkillInstallSource, name: string, text: string): this {
    this.#staged.set(JSON.stringify(source), { name, text });
    return this;
  }

  #visible(): LoadedSkill[] {
    const byName = new Map<string, LoadedSkill>();
    for (const src of SOURCE_ORDER) {
      for (const s of this.#skills)
        if (s.source === src && !byName.has(s.name)) byName.set(s.name, s);
    }
    return [...byName.values()];
  }

  #summary(s: LoadedSkill): SkillSummary {
    const { frontmatter: _f, body: _b, ...summary } = s;
    return { ...summary };
  }

  async list(): Promise<SkillSummary[]> {
    return this.#visible().map((s) => this.#summary(s));
  }

  async load(name: string): Promise<LoadedSkill | undefined> {
    const s = this.#visible().find((x) => x.name === name);
    return s === undefined ? undefined : structuredClone(s);
  }

  async search(query: string, limit = 10): Promise<SkillSummary[]> {
    const q = query.toLowerCase();
    return this.#visible()
      .filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q))
      .slice(0, limit)
      .map((s) => this.#summary(s));
  }

  async proposeInstall(source: SkillInstallSource): Promise<SkillInstallProposal> {
    const staged = this.#staged.get(JSON.stringify(source));
    if (staged === undefined) return fail("not_found", "nothing staged at that source");
    const proposal: SkillInstallProposal = {
      id: this.#ids.next("skp"),
      name: staged.name,
      source: structuredClone(source),
      text: staged.text,
      hash: sha256(staged.text),
      trust: "unknown",
      findings: scanSkillText(staged.text),
      approvalKind: "skill_install",
      manifest: { tools: [], permissions: [], prompts: [] },
    };
    this.#proposals.set(proposal.id, proposal);
    return structuredClone(proposal);
  }

  async install(proposalId: string, approvalId: string): Promise<SkillSummary> {
    const p = this.#proposals.get(proposalId);
    if (p === undefined) return fail("not_found", "proposal not found");
    if (!this.#isApproved(approvalId))
      return fail("approval_required", "skill_install needs an approval");
    this.#proposals.delete(proposalId);
    this.#skills = this.#skills.filter((x) => !(x.name === p.name && x.source === "home"));
    this.#origins.set(p.name, p.source);
    this.add({ name: p.name, description: p.name, body: p.text, source: "home" });
    const s = this.#skills[this.#skills.length - 1];
    if (s === undefined) return fail("internal", "install failed");
    s.trust = "unknown";
    return this.#summary(s);
  }

  async remove(name: string): Promise<void> {
    this.#skills = this.#skills.filter((s) => s.name !== name);
    this.#origins.delete(name);
  }

  /** Compares each installed skill with what is staged at its source now. */
  async checkUpdates(name?: string): Promise<SkillUpdateCheck[]> {
    const out: SkillUpdateCheck[] = [];
    for (const [skill, source] of this.#origins) {
      if (name !== undefined && skill !== name) continue;
      const installed = this.#skills.find((x) => x.name === skill && x.source === "home");
      if (installed === undefined) continue;
      const staged = this.#staged.get(JSON.stringify(source));
      const availableHash = staged === undefined ? undefined : sha256(staged.text);
      out.push({
        name: skill,
        installedHash: installed.hash,
        ...(availableHash === undefined
          ? { error: "nothing staged at the source" }
          : { availableHash }),
        updateAvailable: availableHash !== undefined && availableHash !== installed.hash,
        manifestChanged: false,
        checkedAt: 0,
      });
    }
    return out;
  }

  async promptIndex(options: PromptIndexOptions = {}): Promise<PromptIndex> {
    const budget = options.budgetChars ?? 8_000;
    const maxDesc = options.maxDescriptionChars ?? 280;
    const skills = this.#visible()
      .filter((s) => s.enabled && !s.disableModelInvocation)
      .sort((a, b) => a.name.localeCompare(b.name));
    const included: string[] = [];
    let body = "";
    for (const s of skills) {
      const line = `<skill name="${s.name}" trust="${s.trust}">${s.description.slice(0, maxDesc)}</skill>\n`;
      if (body.length + line.length > budget) break;
      body += line;
      included.push(s.name);
    }
    const omitted = skills.slice(included.length).map((s) => s.name);
    if (omitted.length > 0) body += `<omitted count="${omitted.length}"/>\n`;
    return { text: `<available_skills>\n${body}</available_skills>`, included, omitted };
  }

  async commands(): Promise<SkillCommand[]> {
    return this.#visible()
      .filter((s) => s.enabled && s.userInvocable)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({
        command: `/${s.name}`,
        name: s.name,
        description: s.description,
        source: s.source,
        trust: s.trust,
      }));
  }

  async setEnabled(name: string, enabled: boolean, source?: SkillSource): Promise<SkillSummary> {
    const s =
      source === undefined
        ? this.#visible().find((x) => x.name === name)
        : this.#skills.find((x) => x.name === name && x.source === source);
    if (s === undefined) return fail("not_found", `no skill named ${name}`);
    s.enabled = enabled;
    return this.#summary(s);
  }
}
