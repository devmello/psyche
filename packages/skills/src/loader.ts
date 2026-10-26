import {
  existsSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type LoadedSkill,
  type PermissionBroker,
  PsycheError,
  type SkillInstallProposal,
  type SkillInstallSource,
  type SkillLoader,
  type SkillSource,
  type SkillSummary,
  type SkillTrust,
  type SkillUpdateCheck,
  type SpecialistRole,
} from "@psyche/protocol";
import { skillInstallBinding } from "./binding.ts";
import { unifiedDiff } from "./diff.ts";
import { NAME_PATTERN, type ParsedSkill, parseSkill } from "./frontmatter.ts";
import { defaultGateContext, evaluateGates, type GateContext } from "./gating.ts";
import { LOCK_FILE, type LockEntry, type LockFile, lockKey, readLock, writeLock } from "./lock.ts";
import { manifestOf, manifestsDiffer, type SkillManifest } from "./manifest.ts";
import { policyViolations, type SkillInstallPolicy } from "./policy.ts";
import {
  buildPromptIndex,
  extractSkillReferences,
  type PromptIndex,
  type PromptIndexOptions,
  type SkillCommand,
  toCommand,
} from "./prompt.ts";
import {
  hasBlockingFindings,
  type SkillScanFinding,
  scanSkillTree,
  summarizeFindings,
} from "./scanner.ts";
import { fetchSource, type SourceOptions } from "./sources.ts";
import {
  effectiveMaxMode,
  parseSpecialist,
  resolveSpecialistTools,
  type SpecialistDef,
  specialistRoleOf,
} from "./specialists.ts";
import { MemorySkillStateStore, type SkillStateStore } from "./state.ts";
import { readSkillDir, type SkillTree, textOf, treeHash } from "./tree.ts";
import type { VirusTotalClient } from "./virustotal.ts";

/**
 * Why a skill is (not) active. `active` is the only status that reaches the prompt.
 * - `draft`: a workspace skill the owner has not approved, or approved content that changed
 *   is reported as `hash_mismatch` (review design-02, design-24);
 * - `unlocked`: a folder in `$PSYCHE_HOME/skills/` that was not installed through Psyche;
 * - `blocked`: the static scan has a `high` finding;
 * - `ineligible`: gating (`requires.*`) fails on this machine;
 * - `shadowed`: a skill of the same name in a higher-precedence source wins.
 */
export type SkillStatus =
  | "active"
  | "disabled"
  | "draft"
  | "unlocked"
  | "hash_mismatch"
  | "invalid"
  | "blocked"
  | "ineligible"
  | "shadowed";

export interface SkillDetails extends SkillSummary {
  status: SkillStatus;
  reasons: string[];
  findings: SkillScanFinding[];
  /** The owner's switch (the summary's `enabled` is the effective state). */
  userEnabled: boolean;
  /** Lower-precedence sources this skill overrides (Settings: "overrides bundled"). */
  overrides: SkillSource[];
  version?: string;
  commit?: string;
  /** What the skill declares it needs (absent when its frontmatter could not be read). */
  manifest?: SkillManifest;
  /** The last update check for an installed skill (`checkUpdates`). */
  update?: SkillUpdateCheck;
  /**
   * The background specialist role this skill defines (`metadata.psyche.specialist`,
   * docs/agent/specialists-2026.md §5). `tools` is the resolved allowlist when the Gateway's
   * tool list is known (`gate.tools`), else the declared patterns; `unresolved` lists entries
   * that matched no tool.
   */
  specialist?: SpecialistDef & { resolvedTools: string[]; unresolved: string[] };
}

export interface SkillProposal extends SkillInstallProposal {
  /** Every file of the skill (security §11: show every bundled file); binary files have no text. */
  files: { path: string; bytes: number; executable: boolean; text?: string }[];
  scope: "home" | "workspace";
  bindingHash: `sha256:${string}`;
  grantKey: string;
  commit?: string;
  /** Present for updates and re-approvals: the installed hash and a unified diff per file. */
  update?: { fromHash: string; upToDate: boolean; diff: string };
  /** Epoch ms. */
  expiresAt: number;
  manifest: SkillManifest;
}

export type SkillChangeEvent =
  | { type: "reloaded"; added: string[]; removed: string[]; changed: string[] }
  | { type: "hash_mismatch"; name: string; source: SkillSource; path: string }
  | { type: "installed"; name: string; hash: string; enabled: boolean }
  | { type: "removed"; name: string; source: SkillSource };

export interface FsSkillLoaderOptions {
  /** `$PSYCHE_HOME/workspace/skills`. */
  workspaceDir?: string;
  /** `$PSYCHE_HOME/skills` (installed skills and `skills.lock.json`). */
  homeDir: string;
  /** The repository's `skills/` (S20's bundled skills). */
  bundledDir?: string;
  state?: SkillStateStore;
  /** Verifies `skill_install` approvals and records receipts. Without it, installs are refused. */
  broker?: PermissionBroker;
  /**
   * What a skill's manifest may ask for (or a function returning the owner's current policy).
   * Default: `SKILL_FORBIDDEN_PERMISSIONS` and `SKILL_FORBIDDEN_TOOLS` only.
   */
  installPolicy?: SkillInstallPolicy | (() => SkillInstallPolicy);
  /** Gating context (or a function returning the current one, e.g. with the live tool list). */
  gate?: GateContext | (() => GateContext);
  virusTotal?: VirusTotalClient;
  sourceOptions?: SourceOptions;
  /** Workspace skills need an owner approval before they reach the prompt. Default true. */
  requireWorkspaceApproval?: boolean;
  /** Proposal lifetime (default 30 minutes, like approvals). */
  proposalTtlMs?: number;
  now?: () => number;
  newId?: () => string;
  onChange?: (event: SkillChangeEvent) => void;
}

interface Entry {
  details: SkillDetails;
  dir: string;
  parsed?: ParsedSkill;
  tree?: SkillTree;
  lock?: LockEntry;
}

const SOURCES: SkillSource[] = ["workspace", "home", "bundled"];
const TTL_MS = 30 * 60 * 1000;

/**
 * `SkillLoader` over the file system (architecture §13, features T1 and T2). Discovery order
 * workspace → `$PSYCHE_HOME/skills` → bundled; the first *approved, valid* skill of a name wins.
 * Without a watcher, every read rescans (skill folders are small); `watch()` switches to
 * event-driven reloads.
 */
export class FsSkillLoader implements SkillLoader {
  #o: FsSkillLoaderOptions;
  #state: SkillStateStore;
  #entries: Entry[] = [];
  #winners = new Map<string, Entry>();
  #proposals = new Map<string, { proposal: SkillProposal; tree: SkillTree }>();
  #watchers: FSWatcher[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #rescan: ReturnType<typeof setInterval> | undefined;
  #watching = false;
  #busy = false;
  #debounceMs = 150;
  #reported = new Set<string>();
  #updates = new Map<string, SkillUpdateCheck>();
  #gatedWith = "";
  #now: () => number;
  #newId: () => string;

  constructor(options: FsSkillLoaderOptions) {
    this.#o = options;
    this.#state = options.state ?? new MemorySkillStateStore();
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.refresh();
  }

  get lockPath(): string {
    return join(this.#o.homeDir, LOCK_FILE);
  }

  #root(source: SkillSource): string | undefined {
    if (source === "workspace") return this.#o.workspaceDir;
    if (source === "home") return this.#o.homeDir;
    return this.#o.bundledDir;
  }

  #policy(): SkillInstallPolicy {
    const p = this.#o.installPolicy;
    if (p === undefined) return {};
    return typeof p === "function" ? p() : p;
  }

  #gate(): GateContext {
    const g = this.#o.gate;
    if (g === undefined) return defaultGateContext();
    return typeof g === "function" ? g() : g;
  }

  // --- Discovery -------------------------------------------------------------------------------

  /** Rescans every source. Returns what changed since the previous scan. */
  refresh(): { added: string[]; removed: string[]; changed: string[] } {
    const before = new Map(this.#entries.map((e) => [key(e.details), e.details]));
    const lock = this.#readLock();
    const gate = this.#gate();
    this.#gatedWith = gate.tools === undefined ? "" : [...gate.tools].sort().join("\n");
    const entries: Entry[] = [];
    for (const source of SOURCES) {
      const root = this.#root(source);
      if (root === undefined || !existsSync(root)) continue;
      for (const name of readdirSync(root).sort()) {
        const dir = join(root, name);
        if (name.startsWith(".") || !isDir(dir) || !existsSync(join(dir, "SKILL.md"))) continue;
        entries.push(this.#discover(source, name, dir, lock, gate));
      }
    }
    // Precedence among approved, valid skills; everything else neither wins nor shadows.
    const winners = new Map<string, Entry>();
    const competing: SkillStatus[] = ["active", "disabled", "blocked", "ineligible"];
    for (const e of entries) {
      if (!competing.includes(e.details.status)) continue;
      const w = winners.get(e.details.name);
      if (w === undefined) winners.set(e.details.name, e);
      else {
        w.details.overrides.push(e.details.source);
        e.details.status = "shadowed";
        e.details.enabled = false;
        e.details.reasons.push(`overridden by the ${w.details.source} skill of the same name`);
      }
    }
    this.#entries = entries;
    this.#winners = winners;

    for (const e of entries) {
      if (e.details.status === "hash_mismatch") {
        const k = `${key(e.details)}|${e.details.hash}`;
        if (!this.#reported.has(k)) {
          this.#reported.add(k);
          this.#o.onChange?.({
            type: "hash_mismatch",
            name: e.details.name,
            source: e.details.source,
            path: e.details.path,
          });
        }
      }
    }
    const after = new Map(entries.map((e) => [key(e.details), e.details]));
    const added = [...after.keys()].filter((k) => !before.has(k));
    const removed = [...before.keys()].filter((k) => !after.has(k));
    const changed = [...after.entries()]
      .filter(([k, d]) => {
        const b = before.get(k);
        return b !== undefined && (b.hash !== d.hash || b.status !== d.status);
      })
      .map(([k]) => k);
    return { added, removed, changed };
  }

  #discover(
    source: SkillSource,
    folder: string,
    dir: string,
    lock: LockFile,
    gate: GateContext,
  ): Entry {
    const path = join(dir, "SKILL.md");
    const details: SkillDetails = {
      name: folder,
      description: "",
      source,
      path,
      trust: source === "bundled" ? "bundled" : source === "workspace" ? "local" : "unknown",
      userInvocable: false,
      disableModelInvocation: false,
      enabled: false,
      hash: "",
      status: "invalid",
      reasons: [],
      findings: [],
      userEnabled: true,
      overrides: [],
    };
    const entry: Entry = { details, dir };
    let tree: SkillTree;
    try {
      tree = readSkillDir(dir);
    } catch (err) {
      details.reasons.push((err as Error).message);
      return entry;
    }
    entry.tree = tree;
    details.hash = treeHash(tree);
    const text = textOf(tree.get("SKILL.md") ?? { bytes: new Uint8Array(), executable: false });
    const parsed = text === undefined ? undefined : parseSkill(text, folder);
    if (parsed === undefined || !parsed.ok) {
      details.reasons.push(...(parsed?.ok === false ? parsed.errors : ["SKILL.md is not UTF-8"]));
      return entry;
    }
    entry.parsed = parsed.skill;
    const m = parsed.skill.meta;
    details.description = m.description;
    details.userInvocable = m.userInvocable;
    details.disableModelInvocation = m.disableModelInvocation;
    if (m.version !== undefined) details.version = m.version;
    const manifest = manifestOf(m, tree);
    if (!manifest.ok) {
      details.reasons.push(...manifest.errors);
      return entry;
    }
    details.manifest = manifest.manifest;
    const spec = parseSpecialist(parsed.skill.frontmatter as Record<string, unknown>);
    if (spec.present && !spec.ok) {
      details.reasons.push(...spec.errors);
      return entry;
    }
    if (spec.present && spec.ok) {
      const resolved =
        gate.tools === undefined
          ? { tools: [...spec.def.tools], unresolved: [] }
          : resolveSpecialistTools(spec.def, gate.tools);
      details.specialist = {
        ...spec.def,
        maxMode: effectiveMaxMode(spec.def),
        resolvedTools: resolved.tools,
        unresolved: resolved.unresolved,
      };
    }

    // Trust: bundled ships with Psyche; everything else needs a matching lock entry.
    if (source !== "bundled") {
      const lk = lock.skills[lockKey(source === "home" ? "home" : "workspace", folder)];
      const needsLock = source === "home" || this.#o.requireWorkspaceApproval !== false;
      if (lk !== undefined) {
        entry.lock = lk;
        details.trust = lk.trust;
        if (lk.commit !== undefined) details.commit = lk.commit;
      }
      if (needsLock && lk === undefined) {
        details.status = source === "home" ? "unlocked" : "draft";
        details.reasons.push(
          source === "home"
            ? "not installed through Psyche (no lock entry)"
            : "not approved by the owner yet",
        );
        return entry;
      }
      if (lk !== undefined && lk.treeHash !== details.hash) {
        details.status = "hash_mismatch";
        details.reasons.push("files changed since the owner approved this skill");
        return entry;
      }
      details.findings = scanSkillTree(tree, folder);
    }
    // The owner may have tightened the policy since the install: such a skill stops loading.
    const violations =
      source === "bundled" ? [] : policyViolations(manifest.manifest, this.#policy());

    const st = this.#state.get(source, folder);
    details.userEnabled = st?.enabled ?? true;
    const gates = evaluateGates(m.requires, gate);
    if (hasBlockingFindings(details.findings) || (entry.lock?.findings.high ?? 0) > 0) {
      details.status = "blocked";
      details.reasons.push("the static scan has high-severity findings");
    } else if (violations.length > 0) {
      details.status = "blocked";
      details.reasons.push(...violations);
    } else if (!details.userEnabled) {
      details.status = "disabled";
      details.reasons.push("disabled by the owner");
    } else if (!gates.eligible) {
      details.status = "ineligible";
      details.reasons.push(...gates.missing);
    } else if (details.specialist !== undefined && details.specialist.resolvedTools.length === 0) {
      // A role with none of its tools on this Gateway has nothing to work with.
      details.status = "ineligible";
      details.reasons.push(`none of the ${details.specialist.label} role's tools are available`);
    } else {
      details.status = "active";
      details.enabled = true;
    }
    return entry;
  }

  #readLock(): LockFile {
    try {
      return readLock(this.lockPath);
    } catch (err) {
      // A corrupt lock file trusts nothing and is never silently rewritten.
      throw new PsycheError("internal", `cannot read ${LOCK_FILE}: ${(err as Error).message}`);
    }
  }

  /**
   * Without a watcher every read rescans. With one, a read still rescans when the agent's tool
   * set changed since the last scan (a connector connected, the browser turned on), so gating
   * never stays at the snapshot taken while the Gateway was starting (#506).
   */
  #fresh(): void {
    if (!this.#watching || this.#gateKey() !== this.#gatedWith) this.refresh();
  }

  #gateKey(): string {
    const tools = this.#gate().tools;
    return tools === undefined ? "" : [...tools].sort().join("\n");
  }

  // --- SkillLoader -----------------------------------------------------------------------------

  /** Winners plus drafts, unlocked, mismatched and invalid skills (Settings shows all). */
  async list(): Promise<SkillSummary[]> {
    return (await this.listDetailed()).map(toSummary);
  }

  async listDetailed(): Promise<SkillDetails[]> {
    this.#fresh();
    return this.#entries.map((e) => {
      const d = structuredClone(e.details);
      const u = d.source === "home" ? this.#updates.get(d.name) : undefined;
      if (u !== undefined && u.installedHash === d.hash) d.update = structuredClone(u);
      return d;
    });
  }

  /** Every discovered skill name, any source or status (synchronous; for name collisions). */
  names(): string[] {
    this.#fresh();
    return [...new Set(this.#entries.map((e) => e.details.name))];
  }

  /** The winning skill of `name` with its body, or `undefined` (never drafts or invalid ones). */
  async load(name: string): Promise<LoadedSkill | undefined> {
    this.#fresh();
    const e = this.#winners.get(name);
    if (e?.parsed === undefined) return undefined;
    return {
      ...toSummary(e.details),
      frontmatter: structuredClone(e.parsed.frontmatter),
      body: e.parsed.body,
    };
  }

  /** Active skills matching the words of `query` in name or description, best first. */
  async search(query: string, limit = 10): Promise<SkillSummary[]> {
    this.#fresh();
    const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const scored: { d: SkillDetails; score: number }[] = [];
    for (const e of this.#winners.values()) {
      if (!e.details.enabled) continue;
      const name = e.details.name.toLowerCase();
      const desc = e.details.description.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (name === w) score += 5;
        else if (name.includes(w)) score += 3;
        if (desc.includes(w)) score += 1;
      }
      if (words.length === 0 || score > 0) scored.push({ d: e.details, score });
    }
    scored.sort((a, b) => b.score - a.score || a.d.name.localeCompare(b.d.name));
    return scored.slice(0, limit).map((s) => toSummary(s.d));
  }

  // --- Prompt, references, commands -----------------------------------------------------------

  /** The `<available_skills>` block for model-invocable active skills. */
  async promptIndex(options?: PromptIndexOptions): Promise<PromptIndex> {
    this.#fresh();
    const skills = [...this.#winners.values()]
      .map((e) => e.details)
      .filter((d) => d.enabled && !d.disableModelInvocation);
    return buildPromptIndex(skills, options);
  }

  /**
   * Background specialist roles from active skills (specialists §5), winners only, for
   * `specialists.list` and `specialist.spawn`. Roles from non-bundled skills come with
   * `defaultOn: false`: they stay off until the owner turns them on in Settings.
   */
  async specialistRoles(): Promise<
    {
      skill: SkillDetails;
      role: Omit<SpecialistRole, "enabled" | "model">;
      defaultOn: boolean;
      body: string;
    }[]
  > {
    this.#fresh();
    const out = [];
    for (const e of this.#winners.values()) {
      const d = e.details;
      if (!d.enabled || d.specialist === undefined || e.parsed === undefined) continue;
      out.push({
        skill: structuredClone(d),
        role: {
          ...specialistRoleOf(d.specialist, d),
          tools: [...d.specialist.resolvedTools],
        },
        defaultOn: d.source === "bundled",
        body: e.parsed.body,
      });
    }
    // One skill per role id: the first winner (workspace before home before bundled) keeps it.
    const seen = new Set<string>();
    return out
      .sort((a, b) => SOURCES.indexOf(a.skill.source) - SOURCES.indexOf(b.skill.source))
      .filter((r) => {
        if (seen.has(r.role.role)) return false;
        seen.add(r.role.role);
        return true;
      });
  }

  /** Composer slash commands: active, user-invocable skills. */
  async commands(): Promise<SkillCommand[]> {
    this.#fresh();
    return [...this.#winners.values()]
      .map((e) => e.details)
      .filter((d) => d.enabled && d.userInvocable)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(toCommand);
  }

  /** Active skills referenced as `$name` in an owner message (at most eight). */
  async resolveReferences(text: string, max = 8): Promise<LoadedSkill[]> {
    this.#fresh();
    const active = new Set(
      [...this.#winners.values()].filter((e) => e.details.enabled).map((e) => e.details.name),
    );
    const out: LoadedSkill[] = [];
    for (const name of extractSkillReferences(text, active, max)) {
      const s = await this.load(name);
      if (s !== undefined) out.push(s);
    }
    return out;
  }

  // --- Owner switches --------------------------------------------------------------------------

  /** Enables or disables the winning skill (or the one from `source`). */
  async setEnabled(name: string, enabled: boolean, source?: SkillSource): Promise<SkillDetails> {
    this.refresh();
    const e =
      source === undefined
        ? (this.#winners.get(name) ?? this.#entries.find((x) => x.details.name === name))
        : this.#entries.find((x) => x.details.name === name && x.details.source === source);
    if (e === undefined) throw new PsycheError("not_found", `no skill named ${name}`);
    const d = e.details;
    if (
      enabled &&
      ["draft", "unlocked", "hash_mismatch", "invalid", "blocked"].includes(d.status)
    ) {
      throw new PsycheError("policy_denied", `cannot enable ${name}: ${d.reasons.join("; ")}`, {
        details: { status: d.status, findings: d.findings.filter((f) => f.severity === "high") },
      });
    }
    this.#state.upsert({
      name,
      source: d.source,
      path: d.path,
      trust: d.trust,
      enabled,
      ...(d.hash === "" ? {} : { hash: d.hash }),
      ...(d.version === undefined ? {} : { version: d.version }),
      ...(e.lock === undefined ? {} : { installedAt: e.lock.approvedAt }),
    });
    this.refresh();
    const after = this.#entries.find(
      (x) => x.details.name === name && x.details.source === d.source,
    );
    return structuredClone((after ?? e).details);
  }

  // --- Install and trust -----------------------------------------------------------------------

  /** Fetches, scans and stages a third-party skill for `$PSYCHE_HOME/skills/`. */
  async proposeInstall(source: SkillInstallSource): Promise<SkillProposal> {
    const fetched = await fetchSource(source, this.#o.sourceOptions);
    return this.#propose("home", source, fetched.tree, fetched.commit);
  }

  /** Re-fetches an installed skill from its pinned source and stages the update with a diff. */
  async proposeUpdate(name: string, ref?: string): Promise<SkillProposal> {
    const lk = this.#readLock().skills[lockKey("home", name)];
    if (lk === undefined || lk.origin.kind === "workspace")
      throw new PsycheError("not_found", `${name} was not installed from a source`);
    const origin: SkillInstallSource =
      lk.origin.kind === "git" && ref !== undefined ? { ...lk.origin, ref } : lk.origin;
    const fetched = await fetchSource(origin, this.#o.sourceOptions);
    return this.#propose("home", origin, fetched.tree, fetched.commit);
  }

  /** Stages the owner's approval of a workspace skill (draft or changed). */
  async proposeWorkspaceApproval(name: string): Promise<SkillProposal> {
    const dir = this.#o.workspaceDir;
    if (dir === undefined) throw new PsycheError("not_found", "no workspace skills folder");
    if (!NAME_PATTERN.test(name)) throw new PsycheError("invalid_params", "invalid skill name");
    const skillDir = join(dir, name);
    if (!existsSync(join(skillDir, "SKILL.md")))
      throw new PsycheError("not_found", `no workspace skill named ${name}`);
    return this.#propose("workspace", { kind: "path", path: skillDir }, readSkillDir(skillDir));
  }

  async #propose(
    scope: "home" | "workspace",
    source: SkillInstallSource,
    tree: SkillTree,
    commit?: string,
  ): Promise<SkillProposal> {
    const skillMd = tree.get("SKILL.md");
    const text = skillMd === undefined ? undefined : textOf(skillMd);
    const parsed = text === undefined ? undefined : parseSkill(text);
    if (parsed === undefined || !parsed.ok) {
      throw new PsycheError(
        "invalid_params",
        `not a valid skill: ${parsed?.ok === false ? parsed.errors.join("; ") : "SKILL.md missing or not text"}`,
      );
    }
    const name = parsed.skill.meta.name;
    const declared = manifestOf(parsed.skill.meta, tree);
    if (!declared.ok) {
      throw new PsycheError(
        "invalid_params",
        `invalid skill manifest: ${declared.errors.join("; ")}`,
      );
    }
    const manifest = declared.manifest;
    const violations = policyViolations(manifest, this.#policy());
    if (violations.length > 0) {
      // Refused before any card exists: the owner is never asked to approve what policy forbids.
      throw new PsycheError(
        "policy_denied",
        `skill ${name} asks for more than the policy allows: ${violations.join("; ")}`,
        { details: { name, violations, manifest } },
      );
    }
    if (scope === "workspace" && source.kind === "path" && !source.path.endsWith(`/${name}`)) {
      throw new PsycheError("invalid_params", `skill name ${name} must equal its folder name`);
    }
    const folded = new Set<string>();
    for (const path of tree.keys()) {
      const k = path.normalize("NFC").toLowerCase();
      // Case-insensitive APFS would merge these on disk after the approval is spent.
      if (folded.has(k))
        throw new PsycheError("invalid_params", `paths differ only in case: ${path}`);
      folded.add(k);
    }
    const hash = treeHash(tree);
    const findings = scanSkillTree(tree, name);
    if (this.#o.virusTotal !== undefined) findings.push(...(await this.#o.virusTotal.scan(tree)));
    this.refresh();
    const sameName = this.#entries.filter((e) => e.details.name === name);
    if (scope === "home" && sameName.some((e) => e.details.source === "bundled")) {
      findings.push({
        rule: "overrides-bundled",
        severity: "warn",
        message: `replaces the bundled skill "${name}"`,
      });
    }
    let update: SkillProposal["update"];
    if (scope === "home") {
      const installed = sameName.find((e) => e.details.source === "home" && e.tree !== undefined);
      if (installed?.tree !== undefined && installed.lock !== undefined) {
        update = {
          fromHash: installed.lock.treeHash,
          upToDate: installed.lock.treeHash === hash,
          diff: treeDiff(installed.tree, tree),
        };
      }
    } else {
      // The workspace is agent-writable: compare with the snapshot taken at the last approval.
      const lk = this.#readLock().skills[lockKey("workspace", name)];
      const snap = join(this.#snapshotRoot(), name);
      if (lk !== undefined && existsSync(snap)) {
        update = {
          fromHash: lk.treeHash,
          upToDate: lk.treeHash === hash,
          diff: treeDiff(readSkillDir(snap), tree),
        };
      }
    }
    const id = this.#newId();
    const files = [...tree.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, f]) => {
        const t = textOf(f);
        return {
          path,
          bytes: f.bytes.byteLength,
          executable: f.executable,
          ...(t === undefined ? {} : { text: t }),
        };
      });
    const proposal: SkillProposal = {
      id,
      name,
      source: structuredClone(source),
      text: text ?? "",
      hash,
      trust: scope === "workspace" ? "local" : "unknown",
      findings,
      approvalKind: "skill_install",
      files,
      scope,
      ...skillInstallBinding({
        name,
        scope,
        source,
        ...(commit === undefined ? {} : { commit }),
        treeHash: hash,
        ...manifest,
      }),
      ...(commit === undefined ? {} : { commit }),
      ...(update === undefined ? {} : { update }),
      expiresAt: this.#now() + (this.#o.proposalTtlMs ?? TTL_MS),
      manifest,
    };
    this.#proposals.set(id, { proposal, tree });
    return structuredClone(proposal);
  }

  /**
   * Installs (or approves) a staged proposal. Needs an approved `skill_install` whose binding
   * matches the proposal; writes exactly the scanned tree, pins it in the lock file and records
   * a receipt. A skill with `high` findings is installed disabled.
   */
  async install(proposalId: string, approvalId: string): Promise<SkillSummary> {
    const staged = this.#proposals.get(proposalId);
    if (staged === undefined) throw new PsycheError("not_found", "no such install proposal");
    const { proposal: p, tree } = staged;
    if (this.#now() > p.expiresAt) {
      this.#proposals.delete(proposalId);
      throw new PsycheError("approval_expired", "the install proposal expired; propose it again");
    }
    const broker = this.#o.broker;
    if (broker === undefined)
      throw new PsycheError("approval_required", "installing a skill needs the Permission Broker");
    const violations = policyViolations(p.manifest, this.#policy());
    if (violations.length > 0) {
      this.#proposals.delete(proposalId);
      throw new PsycheError(
        "policy_denied",
        `skill ${p.name} asks for more than the policy allows: ${violations.join("; ")}`,
        { details: { name: p.name, violations, manifest: p.manifest } },
      );
    }
    const approval = await broker.get(approvalId);
    if (approval === undefined || approval.kind !== "skill_install")
      throw new PsycheError(
        "approval_required",
        "installing a skill needs an approved skill_install",
      );
    const v = await broker.verifyBinding(approvalId, p.bindingHash);
    if (!v.ok) {
      throw new PsycheError(
        v.reason === "binding_mismatch" ? "binding_mismatch" : "approval_required",
        `skill_install approval not usable: ${v.reason}`,
      );
    }
    this.#proposals.delete(proposalId);

    const root = p.scope === "home" ? this.#o.homeDir : this.#o.workspaceDir;
    if (root === undefined) throw new PsycheError("internal", "no folder for this skill scope");
    const target = join(root, p.name);
    // Watcher reloads wait until the files and the lock agree (no false hash_mismatch).
    this.#busy = true;
    try {
      if (p.scope === "home") {
        writeTree(root, target, tree);
      } else {
        if (treeHash(readSkillDir(target)) !== p.hash)
          throw new PsycheError("conflict", "the workspace skill changed after the proposal");
        writeTree(this.#snapshotRoot(), join(this.#snapshotRoot(), p.name), tree);
      }
      this.#writeInstall(p, approvalId, target);
    } finally {
      this.#busy = false;
    }
    const counts = summarizeFindings(p.findings);
    const blocked = counts.high > 0;
    await broker.recordReceipt({
      kind: "skill_install",
      outcome: "ok",
      summary: `${p.update === undefined ? "Installed" : "Updated"} skill ${p.name}${blocked ? " (disabled: scan findings)" : ""}`,
      approvalId,
      externalRefs: {
        skill: p.name,
        hash: p.hash,
        ...(p.commit === undefined ? {} : { commit: p.commit }),
      },
    });
    this.refresh();
    this.#o.onChange?.({ type: "installed", name: p.name, hash: p.hash, enabled: !blocked });
    const e = this.#entries.find((x) => x.details.name === p.name && x.details.source === p.scope);
    if (e === undefined) throw new PsycheError("internal", "installed skill did not load");
    return toSummary(e.details);
  }

  /** `$PSYCHE_HOME/skills/.approved/workspace`: what the owner last approved, for diffs. */
  #snapshotRoot(): string {
    return join(this.#o.homeDir, ".approved", "workspace");
  }

  #writeInstall(p: SkillProposal, approvalId: string, target: string): void {
    const counts = summarizeFindings(p.findings);
    const lock = this.#readLock();
    const approvedAt = new Date(this.#now()).toISOString();
    const version = (parseSkill(p.text) as { ok: true; skill: ParsedSkill }).skill.meta.version;
    lock.skills[lockKey(p.scope, p.name)] = {
      name: p.name,
      scope: p.scope,
      origin: p.scope === "workspace" ? { kind: "workspace" } : p.source,
      ...(p.commit === undefined ? {} : { commit: p.commit }),
      ...(version === undefined ? {} : { version }),
      treeHash: p.hash,
      trust: p.trust,
      approvalId,
      approvedAt,
      findings: counts,
      manifest: p.manifest,
    };
    writeLock(this.lockPath, lock);
    this.#state.upsert({
      name: p.name,
      source: p.scope,
      path: join(target, "SKILL.md"),
      trust: p.trust,
      enabled: counts.high === 0,
      hash: p.hash,
      ...(version === undefined ? {} : { version }),
      installedAt: approvedAt,
    });
  }

  /**
   * Removes an installed skill (files, lock entry, state). For a workspace skill only the
   * approval is withdrawn; the owner's files stay. Bundled skills can only be disabled.
   */
  async remove(name: string): Promise<void> {
    this.refresh();
    const e =
      this.#entries.find((x) => x.details.name === name && x.details.source === "home") ??
      this.#entries.find((x) => x.details.name === name && x.details.source === "workspace");
    if (e === undefined) {
      if (this.#entries.some((x) => x.details.name === name))
        throw new PsycheError("policy_denied", "bundled skills cannot be removed; disable them");
      throw new PsycheError("not_found", `no installed skill named ${name}`);
    }
    const source = e.details.source;
    const lock = this.#readLock();
    const k = lockKey(source === "home" ? "home" : "workspace", name);
    if (lock.skills[k] === undefined) {
      throw new PsycheError(
        "policy_denied",
        source === "home"
          ? `${name} was not installed through Psyche; remove the folder yourself`
          : `${name} is not approved; there is nothing to withdraw`,
      );
    }
    delete lock.skills[k];
    writeLock(this.lockPath, lock);
    if (source === "home") rmSync(e.dir, { recursive: true, force: true });
    else rmSync(join(this.#snapshotRoot(), name), { recursive: true, force: true });
    this.#state.delete(source, name);
    await this.#o.broker?.recordReceipt({
      kind: "skill_remove",
      outcome: "ok",
      summary:
        source === "home"
          ? `Removed skill ${name}`
          : `Withdrew approval of workspace skill ${name}`,
      externalRefs: { skill: name },
    });
    this.refresh();
    this.#o.onChange?.({ type: "removed", name, source });
  }

  /**
   * Update detection: re-fetches each installed skill from its pinned source (a git ref is
   * resolved again, a folder or zip is re-read) and compares the tree hash and the manifest with
   * what the owner approved. Nothing is written; an update still needs `proposeUpdate` and a new
   * `skill_install` approval. A failed fetch is reported per skill, never thrown.
   */
  async checkUpdates(name?: string): Promise<SkillUpdateCheck[]> {
    this.refresh();
    const lock = this.#readLock();
    const out: SkillUpdateCheck[] = [];
    for (const lk of Object.values(lock.skills)) {
      if (lk.scope !== "home" || lk.origin.kind === "workspace") continue;
      if (name !== undefined && lk.name !== name) continue;
      const installed = this.#entries.find(
        (e) => e.details.name === lk.name && e.details.source === "home",
      );
      const checkedAt = this.#now();
      let result: SkillUpdateCheck;
      try {
        const fetched = await fetchSource(lk.origin, this.#o.sourceOptions);
        const availableHash = treeHash(fetched.tree);
        const md = fetched.tree.get("SKILL.md");
        const text = md === undefined ? undefined : textOf(md);
        const parsed = text === undefined ? undefined : parseSkill(text);
        const next = parsed?.ok === true ? manifestOf(parsed.skill.meta, fetched.tree) : undefined;
        result = {
          name: lk.name,
          installedHash: lk.treeHash,
          availableHash,
          ...(fetched.commit === undefined ? {} : { commit: fetched.commit }),
          updateAvailable: availableHash !== lk.treeHash,
          manifestChanged: manifestsDiffer(
            installed?.details.manifest,
            next?.ok === true ? next.manifest : undefined,
          ),
          checkedAt,
        };
      } catch (err) {
        result = {
          name: lk.name,
          installedHash: lk.treeHash,
          updateAvailable: false,
          manifestChanged: false,
          error: (err as Error).message.slice(0, 500),
          checkedAt,
        };
      }
      this.#updates.set(lk.name, result);
      out.push(structuredClone(result));
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Staged proposal by id (for the approval card). */
  getProposal(id: string): SkillProposal | undefined {
    const p = this.#proposals.get(id)?.proposal;
    return p === undefined ? undefined : structuredClone(p);
  }

  // --- Hot reload ------------------------------------------------------------------------------

  /**
   * Watches the skill folders; changes reload after `debounceMs` and emit `reloaded`. A full
   * rescan (re-hashing every tree) also runs every `rescanMs` (default 30 s), so a missed or
   * failed watcher event cannot leave changed files looking approved for long; a watcher that
   * errors is re-created.
   */
  watch(debounceMs = 150, rescanMs = 30_000): () => void {
    if (this.#watching) return () => this.close();
    this.#watching = true;
    this.#debounceMs = debounceMs;
    this.#arm();
    this.#rescan = setInterval(() => this.#schedule(0), rescanMs);
    this.#rescan.unref?.();
    this.refresh();
    return () => this.close();
  }

  #arm(): void {
    for (const w of this.#watchers) w.close();
    this.#watchers = [];
    for (const source of SOURCES) {
      const root = this.#root(source);
      if (root === undefined) continue;
      if (source !== "bundled") mkdirSync(root, { recursive: true, mode: 0o700 });
      if (!existsSync(root)) continue;
      const w = watch(root, { recursive: true }, () => this.#schedule(this.#debounceMs));
      w.on("error", () => {
        if (!this.#watching) return;
        this.#arm();
        this.#schedule(this.#debounceMs);
      });
      this.#watchers.push(w);
    }
  }

  #schedule(ms: number): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#busy) {
        this.#schedule(this.#debounceMs);
        return;
      }
      try {
        const diff = this.refresh();
        if (diff.added.length + diff.removed.length + diff.changed.length > 0)
          this.#o.onChange?.({ type: "reloaded", ...diff });
      } catch {
        // A file mid-write or a folder mid-delete: try again shortly.
        if (this.#watching) this.#schedule(Math.max(this.#debounceMs, 100));
      }
    }, ms);
  }

  close(): void {
    this.#watching = false;
    for (const w of this.#watchers) w.close();
    this.#watchers = [];
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#rescan !== undefined) clearInterval(this.#rescan);
    this.#rescan = undefined;
  }
}

function key(d: Pick<SkillDetails, "source" | "name">): string {
  return `${d.source}:${d.name}`;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function toSummary(d: SkillDetails): SkillSummary {
  return {
    name: d.name,
    description: d.description,
    source: d.source,
    path: d.path,
    trust: d.trust as SkillTrust,
    userInvocable: d.userInvocable,
    disableModelInvocation: d.disableModelInvocation,
    enabled: d.enabled,
    hash: d.hash,
  };
}

/** Unified diff across two trees (added, removed and changed text files). */
export function treeDiff(before: SkillTree, after: SkillTree): string {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  let out = "";
  for (const p of paths) {
    const a = before.get(p);
    const b = after.get(p);
    const at = a === undefined ? undefined : (textOf(a) ?? `<binary ${a.bytes.byteLength} bytes>`);
    const bt = b === undefined ? undefined : (textOf(b) ?? `<binary ${b.bytes.byteLength} bytes>`);
    out += unifiedDiff(p, at, bt);
    if (a !== undefined && b !== undefined && at === bt && a.executable !== b.executable) {
      out += `--- a/${p}\n+++ b/${p}\nmode ${a.executable ? "755" : "644"} → ${b.executable ? "755" : "644"}\n`;
    }
  }
  return out;
}

/** Writes a tree into `root/<name>` atomically: stage beside it, then swap. */
function writeTree(root: string, target: string, tree: SkillTree): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Hidden staging folder: discovery skips dot-folders, so a crash leaves nothing loadable.
  const stamp = `${process.pid}-${Date.now()}`;
  const staging = join(root, ".staging", `${basename(target)}-${stamp}`);
  rmSync(staging, { recursive: true, force: true });
  for (const [path, f] of tree) {
    const abs = join(staging, path);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    writeFileSync(abs, f.bytes, { mode: f.executable ? 0o755 : 0o644, flag: "wx" });
  }
  const old = join(root, ".staging", `old-${basename(target)}-${stamp}`);
  if (existsSync(target)) renameSync(target, old);
  renameSync(staging, target);
  rmSync(old, { recursive: true, force: true });
}
