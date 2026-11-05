import {
  existsSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type BundleSigner as BundleSignerInfo,
  type LoadedSkill,
  type PermissionBroker,
  PsycheError,
  type SkillAuthorVersion,
  type SkillInstallProposal,
  type SkillInstallSource,
  type SkillLoader,
  type SkillSource,
  type SkillSummary,
  type SkillTrust,
  type SkillUpdateCheck,
  type SpecialistRole,
} from "@psyche/protocol";
import { AuthorKeyStore, AuthorRing } from "./authors.ts";
import { skillInstallBinding } from "./binding.ts";
import {
  BUNDLE_EXTENSION,
  type BundleAuthor,
  type BundleOrigin,
  buildBundle,
  bundleHashOf,
  signingBytes,
  type VerifiedBundle,
  verifyBundle,
} from "./bundle.ts";
import { fetchBundleText } from "./bundle-url.ts";
import { unifiedDiff } from "./diff.ts";
import { NAME_PATTERN, type ParsedSkill, parseSkill } from "./frontmatter.ts";
import { defaultGateContext, evaluateGates, type GateContext } from "./gating.ts";
import { LOCK_FILE, type LockEntry, type LockFile, lockKey, readLock, writeLock } from "./lock.ts";
import { manifestOf, manifestsDiffer, type SkillManifest } from "./manifest.ts";
import { buildNotice, NOTICE_EXTENSION, verifyNotice } from "./notice.ts";
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
import {
  foldConflict,
  LESSONS_FILE,
  readSkillDir,
  type SkillTree,
  textOf,
  treeHash,
} from "./tree.ts";
import type { VirusTotalClient } from "./virustotal.ts";
import { type Widened, widenedBy } from "./widen.ts";

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
  /** Where the sender says an imported bundle came from (signed); never `madeBy`, which is for this Mac. */
  bundleOrigin?: BundleOrigin;
  /** The bundle author whose signature verified when the owner approved it. */
  signer?: { keyId: string; name: string; state: "seen" | "trusted" | "revoked" | "own" };
  /** Psyche wrote this skill (lock entry `author`). */
  madeBy?: "agent" | "recording";
  /** Earlier approved versions of an agent-made skill, newest first. */
  history?: SkillAuthorVersion[];
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
  update?: {
    fromHash: string;
    upToDate: boolean;
    diff: string;
    /** What the new version asks for that the installed one did not (empty lists: nothing). */
    widened?: Widened;
    signerChanged?: boolean;
  };
  /** A shared `.psyche-skill` bundle: who signed it and when the author says it was made. */
  bundle?: { signer: BundleSignerInfo; createdAt: string; bytes: number; origin: BundleOrigin };
  /** Approving this card also trusts the bundle's author key (bound into the approval). */
  trustAuthor?: boolean;
  /** Epoch ms. */
  expiresAt: number;
  manifest: SkillManifest;
  /** Psyche wrote this skill (self-extension); recorded in the lock entry. */
  author?: "agent" | "recording";
}

export type SkillChangeEvent =
  | { type: "reloaded"; added: string[]; removed: string[]; changed: string[] }
  | { type: "hash_mismatch"; name: string; source: SkillSource; path: string }
  | { type: "installed"; name: string; hash: string; enabled: boolean }
  | { type: "removed"; name: string; source: SkillSource };

/** Characters of a skill's lessons that reach the prompt (teaching loop §6). */
export const SKILL_LESSONS_BUDGET = 2_000;
/** `- 2026-10-25 [ls_… scope] text`, the teaching loop's lesson lines. */
const LESSON_LINE = /^- \d{4}-\d{2}-\d{2} \[ls_[a-z0-9_]+(?: [a-zA-Z]+=[^\]]+)?\] \S/;

function lessonsBlock(lines: readonly string[]): string {
  return [
    "## Lessons from your feedback",
    "",
    "The owner taught these for this skill; follow them over the steps above where they differ.",
    "",
    ...lines,
  ].join("\n");
}

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
  /**
   * `$PSYCHE_HOME`, for the owner's author key (`identity/author.key`). Without it `exportSkill`
   * answers `unavailable`; importing and trust still work.
   */
  psycheHome?: string;
  /**
   * A background role's definition may have changed under an installed skill (it was installed,
   * updated, or removed): the Gateway turns the role off again until the owner re-enables it.
   */
  onSpecialistReset?: (role: string) => void;
  /** Called when the owner trusts, un-trusts or revokes an author key, or one is created (audit). */
  onAuthorChange?: (event: {
    kind:
      | "author_key_created"
      | "author_trusted"
      | "author_untrusted"
      | "author_revoked"
      | "author_key_rotated"
      | "notice_created"
      | "bundle_revoked"
      | "skill_exported";
    skill?: string;
    treeHash?: string;
    keyId: string;
    name?: string;
  }) => void | Promise<void>;
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
/** Staged install proposals kept at once. */
const MAX_PROPOSALS = 50;

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
  #proposals = new Map<
    string,
    {
      proposal: SkillProposal;
      tree: SkillTree;
      signer?: BundleAuthor;
      /** The signer's earlier keys and the bundle's hash, to recheck a notice at install. */
      lineage?: { keys: string[]; bundleHash: string };
    }
  >();
  #ring: AuthorRing;
  #keys: AuthorKeyStore | undefined;
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
    this.#ring = new AuthorRing(options.homeDir, this.#now);
    this.#keys =
      options.psycheHome === undefined ? undefined : new AuthorKeyStore(options.psycheHome);
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
    const manifest = manifestOf(m, tree, parsed.skill.frontmatter as Record<string, unknown>);
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
    let signerRevoked = false;
    let signerUnreadable = false;
    if (source !== "bundled") {
      const lk = lock.skills[lockKey(source === "home" ? "home" : "workspace", folder)];
      const needsLock = source === "home" || this.#o.requireWorkspaceApproval !== false;
      if (lk !== undefined) {
        entry.lock = lk;
        details.trust = lk.trust;
        if (lk.author !== undefined) details.madeBy = lk.author;
        if (lk.bundleOrigin !== undefined) details.bundleOrigin = lk.bundleOrigin;
        if (lk.commit !== undefined) details.commit = lk.commit;
        if (lk.signer !== undefined) {
          const state = this.#signerState(lk.signer.keyId);
          details.signer = { ...lk.signer, state: state === "unreadable" ? "seen" : state };
          // Un-trusting a key takes the `verified` label back from what it signed.
          if (lk.trust === "verified" && state !== "trusted" && state !== "own")
            details.trust = "unknown";
          if (state === "revoked") signerRevoked = true;
          if (state === "unreadable") signerUnreadable = true;
        }
        // Only a workspace skill is `local`; a lock entry that says otherwise for an installed
        // skill (a hand-edited lock, an old build) is read as a plain third-party skill.
        if (source === "home" && (lk.trust === "local" || lk.trust === "bundled"))
          details.trust = "unknown";
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
    } else if (signerRevoked) {
      details.status = "blocked";
      details.reasons.push("signed by an author key you revoked");
    } else if (signerUnreadable) {
      // Fail closed: if the author list cannot be read, a revocation could be hiding in it.
      details.status = "blocked";
      details.reasons.push("the list of author keys cannot be read");
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

  /** `unreadable`: the keyring or the author key cannot be read, so the skill stays off. */
  #signerState(keyId: string): "seen" | "trusted" | "revoked" | "own" | "unreadable" {
    // The author key file only tells us whether a signature is the owner's own: if it is unsafe
    // that is simply unknown here (exporting reports it), and no skill is blocked for it.
    // A revoked key stays revoked, the owner's own retired keys included.
    try {
      if (this.#ring.get(keyId)?.state === "revoked") return "revoked";
    } catch {
      return "unreadable";
    }
    try {
      if (this.#keys?.peek()?.keyId === keyId) return "own";
      // A key the owner replaced is theirs no longer: it shows, and counts, as unknown.
      if (this.#keys?.retiredKeyIds().includes(keyId) === true) return "seen";
    } catch {
      // fall through to the author list
    }
    try {
      return this.#ring.get(keyId)?.state ?? "seen";
    } catch {
      return "unreadable";
    }
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
      if (d.madeBy === "agent") d.history = this.history(d.name);
      return d;
    });
  }

  /** Every discovered skill name, any source or status (synchronous; for name collisions). */
  names(): string[] {
    this.#fresh();
    return [...new Set(this.#entries.map((e) => e.details.name))];
  }

  /**
   * The winning skill of `name` with its body, or `undefined` (never drafts or invalid ones). The
   * skill's lessons (`<workspace>/skills/<name>/LESSONS.md`, written by the teaching loop after the
   * owner's card) follow the body, newest kept within `SKILL_LESSONS_BUDGET` characters.
   */
  async load(name: string): Promise<LoadedSkill | undefined> {
    this.#fresh();
    const e = this.#winners.get(name);
    if (e?.parsed === undefined) return undefined;
    const lessons = this.lessons(name);
    return {
      ...toSummary(e.details),
      frontmatter: structuredClone(e.parsed.frontmatter),
      body:
        lessons.length === 0
          ? e.parsed.body
          : `${e.parsed.body.trimEnd()}\n\n${lessonsBlock(lessons)}`,
    };
  }

  /** The winning skill of `name`, without its body (synchronous; for drafts and their replay). */
  summarySync(name: string): SkillSummary | undefined {
    this.#fresh();
    const e = this.#winners.get(name);
    return e === undefined ? undefined : toSummary(e.details);
  }

  /** Who made the winning skill of this name (the lock entry), for the drafting code. */
  madeBy(name: string): "agent" | "recording" | undefined {
    this.#fresh();
    return this.#winners.get(name)?.details.madeBy;
  }

  /**
   * Marks a staged proposal as made from a recording of web pages. The Gateway calls it from the
   * draft record (`origin`), never from the skill's own text, which the owner can edit and a
   * third-party skill can imitate. The install writes it into the lock entry.
   */
  markProposalAuthor(proposalId: string, author: "recording"): SkillProposal {
    const staged = this.#proposals.get(proposalId);
    if (staged === undefined) throw new PsycheError("not_found", "no such install proposal");
    if (staged.proposal.scope === "home") staged.proposal.author = author;
    return structuredClone(staged.proposal);
  }

  /** The lesson lines of a skill's `LESSONS.md` that fit the budget, oldest first. */
  lessons(name: string): string[] {
    const dir = this.#o.workspaceDir;
    if (dir === undefined || !NAME_PATTERN.test(name)) return [];
    const path = join(dir, name, LESSONS_FILE);
    if (!existsSync(path)) return [];
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const lines = text.split("\n").filter((l) => LESSON_LINE.test(l.trimEnd()));
    const kept: string[] = [];
    let used = 0;
    for (const line of [...lines].reverse()) {
      if (used + line.length + 1 > SKILL_LESSONS_BUDGET) break;
      kept.unshift(line.trimEnd());
      used += line.length + 1;
    }
    return kept;
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
  async proposeInstall(
    source: SkillInstallSource,
    opts: { trustAuthor?: boolean } = {},
  ): Promise<SkillProposal> {
    const fetched = await fetchSource(source, this.#o.sourceOptions);
    return this.#propose("home", source, fetched.tree, fetched.commit, fetched.bundle, opts);
  }

  /**
   * Verifies and stages a `.psyche-skill` file the owner chose (its text, read by their client).
   * An invalid, tampered or mismatched bundle is refused here, before any card exists.
   */
  async proposeImport(
    fileName: string,
    text: string,
    opts: { trustAuthor?: boolean } = {},
  ): Promise<SkillProposal> {
    const bundle = verifyBundle(text, this.#o.sourceOptions?.limits);
    // Shown on the card and bound into the approval: keep it to plain, short text.
    const name = fileName
      .replace(/[^\w .()+-]/g, "?")
      .trim()
      .slice(0, 200);
    return this.#propose(
      "home",
      { kind: "bundleFile", name: name === "" ? "bundle" : name },
      bundle.tree,
      undefined,
      bundle,
      opts,
    );
  }

  /** Re-fetches an installed skill from its pinned source and stages the update with a diff. */
  async proposeUpdate(
    name: string,
    ref?: string,
    opts: { trustAuthor?: boolean } = {},
  ): Promise<SkillProposal> {
    const lk = this.#readLock().skills[lockKey("home", name)];
    if (lk === undefined || lk.origin.kind === "workspace" || lk.author === "agent")
      throw new PsycheError("not_found", `${name} was not installed from a source`);
    if (lk.origin.kind === "bundleFile")
      throw new PsycheError(
        "invalid_params",
        `${name} came from a file; import the new file to update it`,
      );
    const origin: SkillInstallSource =
      lk.origin.kind === "git" && ref !== undefined ? { ...lk.origin, ref } : lk.origin;
    const fetched = await fetchSource(origin, this.#o.sourceOptions);
    return this.#propose("home", origin, fetched.tree, fetched.commit, fetched.bundle, opts);
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
    bundle?: VerifiedBundle,
    opts: { trustAuthor?: boolean } = {},
  ): Promise<SkillProposal> {
    if (bundle?.signer !== undefined && this.#ring.isRevoked(bundle.signer.keyId))
      throw new PsycheError(
        "policy_denied",
        `this bundle is signed by a key you revoked (${bundle.signer.keyId.slice(0, 23)}…)`,
        { details: { keyId: bundle.signer.keyId } },
      );
    // Two different keys claiming to replace one earlier key: refused until one is revoked.
    if (bundle?.signer !== undefined)
      this.#ring.assertNoFork(bundle.signer.keyId, bundle.ancestors);
    const lineage =
      bundle?.signer === undefined
        ? undefined
        : {
            keys: [bundle.signer.keyId, ...bundle.ancestors],
            bundleHash: bundleHashOf(signingBytes(bundle.manifest)),
          };
    if (
      lineage !== undefined &&
      this.#ring.isBundleRevoked(lineage.bundleHash, bundle?.signer?.keyId)
    )
      throw new PsycheError(
        "policy_denied",
        "an author's signed notice marked this exact bundle as bad; it is not installed",
        { details: { bundleHash: lineage.bundleHash } },
      );
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
    const declared = manifestOf(
      parsed.skill.meta,
      tree,
      parsed.skill.frontmatter as Record<string, unknown>,
    );
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
    // Case-insensitive APFS would merge these on disk after the approval is spent: every path
    // and every folder prefix is compared with full Unicode case and normalization folding.
    const clash = foldConflict(tree.keys());
    if (clash !== undefined)
      throw new PsycheError("invalid_params", `paths differ only in case or form: ${clash}`);
    this.#sweepProposals();
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
    let installedLock: LockEntry | undefined;
    if (scope === "home") {
      const installed = sameName.find((e) => e.details.source === "home" && e.tree !== undefined);
      if (installed?.tree !== undefined && installed.lock !== undefined) {
        installedLock = installed.lock;
        const widened = widenedBy(installed.lock.manifest ?? installed.details.manifest, manifest);
        update = {
          fromHash: installed.lock.treeHash,
          upToDate: installed.lock.treeHash === hash,
          diff: treeDiff(installed.tree, tree),
          ...(widened === undefined ? {} : { widened }),
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
    // Who signed this, against who signed what is installed: for every kind of source, so a
    // signed skill replaced from a folder or a repository is flagged too.
    const installedSigner =
      installedLock === undefined ? undefined : (installedLock.signer ?? null);
    let bundleInfo: SkillProposal["bundle"];
    if (bundle !== undefined) {
      const signer: BundleSignerInfo =
        bundle.signer === undefined
          ? { status: "unsigned", signerChanged: installedSigner != null }
          : this.#ring.statusOf(bundle.signer, this.#keys?.peek(), installedSigner, {
              ancestors: bundle.ancestors,
              ownRetired: this.#retiredKeys(),
            });
      bundleInfo = {
        signer,
        createdAt: bundle.manifest.createdAt,
        bytes: bundle.bytes,
        origin: bundle.manifest.origin,
      };
      if (signer.signerChanged && update !== undefined) update.signerChanged = true;
      if (signer.retired === true) {
        findings.push({
          rule: "retired-key",
          severity: "warn",
          message:
            signer.status === "own"
              ? "signed with a key of yours that you replaced; it is no longer trusted as yours"
              : "this key was replaced by a rotation you have seen; a new file from it is suspect",
        });
      }
      if (signer.status === "rotated") {
        findings.push({
          rule: "signer-rotated",
          severity: "warn",
          message:
            "same author, new key (signed by the old key); the new key is not trusted until you trust it",
        });
      }
      if (signer.status === "changed" || signer.signerChanged) {
        findings.push({
          rule: "signer-changed",
          severity: "warn",
          message:
            bundle.signer === undefined
              ? "the installed version was signed; this one is not"
              : signer.impersonates === true
                ? "the author's name matches your own author name but the key is not yours"
                : "the author's key is not the one seen before; check it is the same person",
        });
      }
      if (signer.nameChanged === true) {
        findings.push({
          rule: "signer-name-changed",
          severity: "warn",
          message: "a key you trust is signing under a name it has not used before",
        });
      }
      // Rollback: an older bundle offered over a newer install of the same skill.
      const was = installedLock?.bundleCreatedAt;
      if (was !== undefined && Date.parse(bundle.manifest.createdAt) < Date.parse(was)) {
        findings.push({
          rule: "older-than-installed",
          severity: "warn",
          message: "this bundle was made before the installed version; it may be a rollback",
        });
      }
    } else if (installedSigner != null) {
      // Not a bundle at all (a folder, an archive, a repository): the signature is gone.
      if (update !== undefined) update.signerChanged = true;
      findings.push({
        rule: "signer-changed",
        severity: "warn",
        message: "the installed version was signed; this source is not",
      });
    }
    if (update?.widened !== undefined) {
      findings.push({
        rule: "permissions-widened",
        severity: "warn",
        message: "this version asks for more than the installed one",
      });
    }
    if (manifest.specialist !== undefined) {
      const role = manifest.specialist.role;
      const other = this.#entries.find(
        (e) => e.details.name !== name && e.details.specialist?.role === role,
      );
      if (other !== undefined) {
        findings.push({
          rule: "role-shadow",
          severity: "warn",
          message: `the background role "${role}" is also defined by the skill "${other.details.name}"`,
        });
      }
    }
    const status = bundleInfo?.signer.status;
    if (opts.trustAuthor === true && bundleInfo?.signer.impersonates === true)
      throw new PsycheError(
        "policy_denied",
        "this author's name matches your own author name but the key is not yours; it cannot be trusted",
      );
    // Trusting the author rides on this very card, so the approver decides it; it makes no
    // sense for an unsigned bundle, a key already trusted or the owner's own.
    const trustAuthor =
      opts.trustAuthor === true &&
      scope === "home" &&
      bundle?.signer !== undefined &&
      status !== "trusted" &&
      status !== "own" &&
      status !== "revoked";
    // A bundle is never `local`: that is for what the owner wrote and approved on this Mac.
    // The exporter's own account of where it came from (signed) can only lower it further:
    // text Psyche wrote stays `unknown` whoever signs it.
    const trust: SkillTrust =
      scope === "workspace"
        ? "local"
        : bundle === undefined || bundle.manifest.origin === "agent"
          ? "unknown"
          : (status === "own" && bundleInfo?.signer.retired !== true) ||
              status === "trusted" ||
              trustAuthor
            ? "verified"
            : "unknown";
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
      trust,
      findings,
      approvalKind: "skill_install",
      files,
      scope,
      ...skillInstallBinding({
        name,
        scope,
        source,
        ...(commit === undefined ? {} : { commit }),
        ...(bundle?.signer === undefined ? {} : { signer: bundle.signer.keyId }),
        ...(trustAuthor ? { trustAuthor: true } : {}),
        treeHash: hash,
        ...manifest,
      }),
      ...(commit === undefined ? {} : { commit }),
      ...(update === undefined ? {} : { update }),
      ...(bundleInfo === undefined ? {} : { bundle: bundleInfo }),
      ...(trustAuthor ? { trustAuthor: true } : {}),
      expiresAt: this.#now() + (this.#o.proposalTtlMs ?? TTL_MS),
      manifest,
    };
    this.#proposals.set(id, {
      proposal,
      tree,
      ...(bundle?.signer === undefined ? {} : { signer: bundle.signer }),
      ...(lineage === undefined ? {} : { lineage }),
    });
    return structuredClone(proposal);
  }

  /** Drops expired proposals, and the oldest when too many are waiting (a link can be spammed). */
  #sweepProposals(): void {
    const now = this.#now();
    for (const [id, v] of this.#proposals)
      if (now > v.proposal.expiresAt) this.#proposals.delete(id);
    while (this.#proposals.size >= MAX_PROPOSALS) {
      const oldest = this.#proposals.keys().next().value;
      if (oldest === undefined) break;
      this.#proposals.delete(oldest);
    }
  }

  /**
   * Installs (or approves) a staged proposal. Needs an approved `skill_install` whose binding
   * matches the proposal; writes exactly the scanned tree, pins it in the lock file and records
   * a receipt. A skill with `high` findings is installed disabled.
   */
  async install(proposalId: string, approvalId: string): Promise<SkillSummary> {
    const staged = this.#proposals.get(proposalId);
    if (staged === undefined) throw new PsycheError("not_found", "no such install proposal");
    const { proposal: p, tree, signer } = staged;
    if (signer !== undefined && this.#ring.isRevoked(signer.keyId)) {
      this.#proposals.delete(proposalId);
      throw new PsycheError("policy_denied", "this bundle is signed by a key you revoked");
    }
    // A notice imported after the card was staged still blocks it.
    if (
      staged.lineage !== undefined &&
      this.#ring.isBundleRevoked(staged.lineage.bundleHash, signer?.keyId)
    ) {
      this.#proposals.delete(proposalId);
      throw new PsycheError("policy_denied", "a signed notice marked this bundle as bad");
    }
    // "Trust this author" is part of what the approved card bound: it changes a label and the
    // warnings for later bundles, and never skips a card.
    const trustNow = p.trustAuthor === true && signer !== undefined && p.scope === "home";
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
    const previousRole =
      this.#readLock().skills[lockKey(p.scope, p.name)]?.manifest?.specialist?.role;
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
      this.#writeInstall(p, approvalId, target, signer);
      if (signer !== undefined) {
        this.#ring.observe(signer, staged.lineage?.keys.slice(1) ?? []);
        if (trustNow) {
          this.#ring.setState(signer.keyId, "trusted");
          this.#notify({
            kind: "author_trusted",
            keyId: signer.keyId,
            name: signer.name,
          });
        }
      }
    } finally {
      this.#busy = false;
    }
    // A role this skill defines may now be wider or different: it starts off again, and stays
    // off until the owner turns it on (the card showed what it asks for).
    for (const role of new Set([previousRole, p.manifest.specialist?.role]))
      if (role !== undefined) this.#o.onSpecialistReset?.(role);
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
        ...(signer === undefined ? {} : { signer: signer.keyId }),
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

  #writeInstall(p: SkillProposal, approvalId: string, target: string, signer?: BundleAuthor): void {
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
      ...(p.author === undefined ? {} : { author: p.author }),
      ...(signer === undefined ? {} : { signer: { keyId: signer.keyId, name: signer.name } }),
      ...(p.bundle === undefined
        ? {}
        : { bundleCreatedAt: p.bundle.createdAt, bundleOrigin: p.bundle.origin }),
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

  // --- Shared bundles: export and author keys --------------------------------------------------

  /** Tells the audit about an author event without letting its failure affect the action. */
  #notify(event: Parameters<NonNullable<FsSkillLoaderOptions["onAuthorChange"]>>[0]): void {
    try {
      const r = this.#o.onAuthorChange?.(event);
      if (r instanceof Promise) r.catch(() => undefined);
    } catch {
      // The audit is best effort for everything but an export.
    }
  }

  #retiredKeys(): string[] {
    try {
      return this.#keys?.retiredKeyIds() ?? [];
    } catch {
      return [];
    }
  }

  #ownKey(): { keyId: string; name: string } | undefined {
    try {
      return this.#keys?.peek();
    } catch {
      return undefined;
    }
  }

  /** The owner's author key (if made) and every author key seen on an imported bundle. */
  authors(): { own?: { keyId: string; name: string }; authors: ReturnType<AuthorRing["list"]> } {
    const own = this.#ownKey();
    return {
      ...(own === undefined ? {} : { own: { keyId: own.keyId, name: own.name } }),
      authors: this.#ring.list(),
    };
  }

  /** Trusts, un-trusts or revokes a key seen on a bundle (owner action; never the agent's). */
  setAuthorState(keyId: string, state: "seen" | "trusted" | "revoked") {
    const author = this.#ring.setState(keyId, state);
    this.#notify({
      kind:
        state === "trusted"
          ? "author_trusted"
          : state === "revoked"
            ? "author_revoked"
            : "author_untrusted",
      keyId,
    });
    this.refresh();
    return author;
  }

  /**
   * What an export would sign, for the approval card: the skill's name, tree hash, files and
   * where it came from. Only what the owner approved can be exported: a workspace skill with a
   * lock entry, a skill Psyche made on this Mac that the owner approved, or one signed with this
   * same key, and only while its files still match the approved hash and carry no high scan
   * finding. A skill someone else wrote (any import, signed or not) is refused, so the owner's
   * key never vouches for it, and the agent cannot get an unreviewed draft signed.
   */
  previewExport(name: string): {
    name: string;
    treeHash: string;
    files: { path: string; bytes: number; executable: boolean }[];
    origin: BundleOrigin;
    version?: string;
    tree: SkillTree;
  } {
    if (!NAME_PATTERN.test(name)) throw new PsycheError("invalid_params", "invalid skill name");
    const lock = this.#readLock();
    const own = this.#ownKey();
    const wk = lock.skills[lockKey("workspace", name)];
    const hk = lock.skills[lockKey("home", name)];
    let dir: string | undefined;
    let approved: LockEntry | undefined;
    let origin: BundleOrigin = "workspace";
    if (wk !== undefined && this.#o.workspaceDir !== undefined) {
      dir = join(this.#o.workspaceDir, name);
      approved = wk;
    } else if (hk !== undefined) {
      // A skill made from a recording carries text from web pages. Signing it would label that
      // text with the owner's key, and a recipient cannot tell it from the owner's own words:
      // it is refused, whoever signed it, rather than exported with an `agent` label.
      if (hk.author === "recording")
        throw new PsycheError(
          "conflict",
          `${name} was made from a recording of web pages and cannot be exported`,
        );
      const imported = hk.origin.kind === "bundleFile" || hk.origin.kind === "bundleUrl";
      const madeHere = hk.author === "agent" && !imported && hk.signer === undefined;
      const ownSigned = own !== undefined && hk.signer?.keyId === own.keyId;
      if (madeHere || ownSigned) {
        dir = join(this.#o.homeDir, name);
        approved = hk;
        // What the exporter says is signed: text Psyche wrote is labelled so for the recipient.
        if (hk.author === "agent") origin = "agent";
      }
    }
    if (dir === undefined || approved === undefined || !existsSync(join(dir, "SKILL.md")))
      throw new PsycheError(
        "conflict",
        `${name} is not a skill you can sign: only your own approved skills, or ones Psyche made for you, can be exported`,
      );
    const tree = readSkillDir(dir, this.#o.sourceOptions?.limits);
    const hash = treeHash(tree);
    if (hash !== approved.treeHash)
      throw new PsycheError(
        "conflict",
        `${name} changed since you approved it; review and approve it before exporting`,
      );
    if (hasBlockingFindings(scanSkillTree(tree, name)))
      throw new PsycheError(
        "conflict",
        `${name} has high-severity scan findings and cannot be exported`,
      );
    return {
      name,
      treeHash: hash,
      files: [...tree.entries()]
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([path, f]) => ({ path, bytes: f.bytes.byteLength, executable: f.executable })),
      origin,
      ...(approved.version === undefined ? {} : { version: approved.version }),
      tree,
    };
  }

  /**
   * Signs what `previewExport` described with the owner's author key (created on first use;
   * `authorName` is then required, with no default) and returns the `.psyche-skill` text.
   * `expectedHash` is the tree hash the owner approved on the card: files that changed since
   * are refused. The bundle records the origin, signed, so recipients can see agent-made text.
   */
  async exportSkill(
    name: string,
    authorName: string | undefined,
    expectedHash: string,
  ): Promise<{
    filename: string;
    bundle: string;
    signer: { keyId: string; name: string };
    createdKey: boolean;
  }> {
    if (this.#keys === undefined)
      throw new PsycheError("unavailable", "this Gateway has no place for an author key");
    const pre = this.previewExport(name);
    if (pre.treeHash !== expectedHash)
      throw new PsycheError("conflict", `${name} changed after you approved the export`);
    const { signer, created } = this.#keys.loadOrCreate(authorName);
    const bundle = buildBundle(
      pre.tree,
      signer,
      new Date(this.#now()),
      pre.origin,
      this.#keys.chain(),
    );
    // The audit comes first and is awaited: a signature that left no record is never returned.
    if (created)
      await this.#o.onAuthorChange?.({
        kind: "author_key_created",
        keyId: signer.author.keyId,
        name: signer.author.name,
      });
    await this.#o.onAuthorChange?.({
      kind: "skill_exported",
      keyId: signer.author.keyId,
      name: signer.author.name,
      skill: name,
      treeHash: pre.treeHash,
    });
    const version = pre.version === undefined ? "" : `-${pre.version.replace(/[^\w.+-]/g, "_")}`;
    return {
      filename: `${name}${version}${BUNDLE_EXTENSION}`,
      bundle,
      signer: { keyId: signer.author.keyId, name: signer.author.name },
      createdKey: created,
    };
  }

  /**
   * Replaces the owner's author key (owner action behind presence; the Gateway gates it). The old
   * key signs a statement naming the new one; the old private key is deleted. Awaited audit, like
   * an export: a rotation that left no record is not returned.
   */
  async rotateAuthorKey(): Promise<{
    from: { keyId: string; name: string };
    to: { keyId: string; name: string };
  }> {
    if (this.#keys === undefined)
      throw new PsycheError("unavailable", "this Gateway has no place for an author key");
    const r = this.#keys.rotate(new Date(this.#now()));
    await this.#o.onAuthorChange?.({
      kind: "author_key_rotated",
      keyId: r.to.keyId,
      name: r.to.name,
    });
    this.refresh();
    return {
      from: { keyId: r.from.keyId, name: r.from.name },
      to: { keyId: r.to.keyId, name: r.to.name },
    };
  }

  /** What a notice would say and sign, for the approval card; refuses a key that is not the owner's. */
  previewNotice(spec: { kind: "key" | "bundle"; keyId?: string; bundleHash?: string }): {
    keyId: string;
  } {
    const own = this.#keys?.peek();
    if (this.#keys === undefined || own === undefined)
      throw new PsycheError("conflict", "there is no author key to sign a notice with yet");
    const keyId = spec.keyId ?? own.keyId;
    const mine = new Set([own.keyId, ...this.#keys.chain().map((c) => c.from.keyId)]);
    if (!mine.has(keyId))
      throw new PsycheError(
        "invalid_params",
        "a notice can only name your own current or earlier key",
      );
    if (spec.kind === "bundle" && spec.bundleHash === undefined)
      throw new PsycheError("invalid_params", "a bundle notice needs the bundle hash");
    return { keyId };
  }

  /** Signs a revocation notice with the owner's author key (after the Gateway's gate). */
  async createNotice(spec: {
    kind: "key" | "bundle";
    keyId?: string;
    bundleHash?: string;
    reason: string;
  }): Promise<{ filename: string; notice: string }> {
    const { keyId } = this.previewNotice(spec);
    const keys = this.#keys as AuthorKeyStore;
    const { signer } = keys.loadOrCreate(undefined);
    const notice = buildNotice(
      signer,
      {
        kind: spec.kind,
        keyId,
        ...(spec.bundleHash === undefined ? {} : { bundleHash: spec.bundleHash }),
        reason: spec.reason,
      },
      new Date(this.#now()),
      keys.chain(),
    );
    // The owner's own notice takes effect on this Mac too (a key of theirs they retired, or a
    // bundle they made), without waiting for anyone to import it.
    this.#ring.applyNotice(verifyNotice(notice), { trustedLocal: true });
    this.refresh();
    await this.#o.onAuthorChange?.({
      kind: "notice_created",
      keyId,
      name: signer.author.name,
      ...(spec.bundleHash === undefined ? {} : { treeHash: spec.bundleHash }),
    });
    return { filename: `revoke-${keyId.slice(7, 15)}${NOTICE_EXTENSION}`, notice };
  }

  /**
   * Applies a revocation notice the owner imported (a file's text; the Gateway fetches a link
   * under the bundle-link rules). It blocks, immediately: installed skills from a revoked key
   * show `blocked` at the next load, and no staged card can install it.
   */
  importNotice(
    text: string,
    opts: { preview?: boolean } = {},
  ): {
    kind: "key" | "bundle";
    keyId: string;
    bundleHash?: string;
    reason: string;
    signer: { keyId: string; name: string };
    applied: boolean;
    names: string[];
    alreadyRevoked: boolean;
    text?: string;
  } {
    const v = verifyNotice(text);
    const base = {
      kind: v.notice.kind,
      keyId: v.notice.keyId,
      ...(v.notice.bundleHash === undefined ? {} : { bundleHash: v.notice.bundleHash }),
      reason: v.notice.reason,
      signer: { keyId: v.notice.signer.keyId, name: v.notice.signer.name },
    };
    // The same checks as applying, so a preview refuses what applying would refuse.
    const preview = this.#ring.previewNotice(v);
    if (opts.preview === true) return { ...base, applied: false, ...preview, text };
    const applied = this.#ring.applyNotice(v);
    this.#notify({
      kind: applied.kind === "key" ? "author_revoked" : "bundle_revoked",
      keyId: applied.keyId,
      name: v.notice.signer.name,
      ...(applied.bundleHash === undefined ? {} : { treeHash: applied.bundleHash }),
    });
    this.refresh();
    return { ...base, applied: true, ...preview };
  }

  /** Downloads a small file (a notice) under the bundle-link rules and this loader's fetch options. */
  async fetchLink(url: string, maxBytes: number): Promise<string> {
    return fetchBundleText(url, { ...this.#o.sourceOptions, maxBytes });
  }

  /** Whether the owner has an author key yet (the first export must name one). */
  hasAuthorKey(): boolean {
    return this.#ownKey() !== undefined;
  }

  /** An author key's current state, or `undefined` if never seen (the gateway gates loosening). */
  authorState(keyId: string): "seen" | "trusted" | "revoked" | undefined {
    return this.#ring.get(keyId)?.state;
  }

  // --- Agent-made skills (self-extension) ------------------------------------------------------

  /** Policy violations of a manifest under the owner's current install policy. */
  policyViolations(manifest: SkillManifest): string[] {
    return policyViolations(manifest, this.#policy());
  }

  /**
   * The approved, agent-made skill `name` in `$PSYCHE_HOME/skills`: its folder, tree and lock
   * entry. `undefined` for anything else (bundled, workspace, owner-installed, never approved).
   * `intact` is false when the files no longer match the approved hash.
   */
  agentOwned(
    name: string,
  ): { dir: string; tree: SkillTree; lock: LockEntry; intact: boolean } | undefined {
    if (!NAME_PATTERN.test(name)) return undefined;
    const lock = this.#readLock().skills[lockKey("home", name)];
    if (lock?.author !== "agent") return undefined;
    const dir = join(this.#o.homeDir, name);
    if (!existsSync(join(dir, "SKILL.md"))) return undefined;
    const tree = readSkillDir(dir);
    return { dir, tree, lock, intact: treeHash(tree) === lock.treeHash };
  }

  /** `$PSYCHE_HOME/skills/.history/<name>`: earlier approved versions (never loaded). */
  #historyDir(name: string): string {
    return join(this.#o.homeDir, ".history", name);
  }

  /** Earlier approved versions of an agent-made skill, newest first. */
  history(name: string): SkillAuthorVersion[] {
    if (!NAME_PATTERN.test(name)) return [];
    const root = this.#historyDir(name);
    if (!existsSync(root)) return [];
    const out: SkillAuthorVersion[] = [];
    for (const n of readdirSync(root)) {
      try {
        const m = JSON.parse(
          readFileSync(join(root, n, "meta.json"), "utf8"),
        ) as SkillAuthorVersion;
        out.push({
          version: m.version,
          hash: m.hash,
          approvedAt: m.approvedAt,
          retiredAt: m.retiredAt,
          retiredBy: m.retiredBy,
        });
      } catch {
        // A half-written or foreign folder is not a version.
      }
    }
    return out.sort((a, b) => b.version - a.version);
  }

  /** Keeps the approved version that is about to be replaced or deleted (at most 20 per skill). */
  #retire(name: string, retiredBy: "update" | "delete"): void {
    const owned = this.agentOwned(name);
    // Only approved content is history: a tampered tree is not kept as "approved".
    if (owned === undefined || !owned.intact) return;
    const root = this.#historyDir(name);
    const last = this.history(name)[0]?.version ?? 0;
    const dir = join(root, String(last + 1));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeTree(root, join(dir, "tree"), owned.tree);
    const meta: SkillAuthorVersion = {
      version: last + 1,
      hash: owned.lock.treeHash,
      approvedAt: owned.lock.approvedAt,
      retiredAt: new Date(this.#now()).toISOString(),
      retiredBy,
    };
    writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    for (const old of this.history(name).slice(20)) {
      rmSync(join(root, String(old.version)), { recursive: true, force: true });
    }
  }

  /**
   * Installs a skill the agent wrote, after the owner approved the tool call's `skill_install` card
   * (the agent loop verified the approval; `approvalId` is recorded). Trust stays `unknown`, the
   * lock entry carries `author: "agent"`, the previous approved version is kept in `.history/`.
   */
  async installAgentTree(a: {
    name: string;
    tree: SkillTree;
    approvalId: string;
    update: boolean;
  }): Promise<SkillSummary> {
    const text = textOf(a.tree.get("SKILL.md") ?? { bytes: new Uint8Array(), executable: false });
    const parsed = text === undefined ? undefined : parseSkill(text, a.name);
    if (parsed === undefined || !parsed.ok)
      throw new PsycheError("invalid_params", "not a valid skill");
    const declared = manifestOf(
      parsed.skill.meta,
      a.tree,
      parsed.skill.frontmatter as Record<string, unknown>,
    );
    if (!declared.ok)
      throw new PsycheError(
        "invalid_params",
        `invalid skill manifest: ${declared.errors.join("; ")}`,
      );
    const violations = policyViolations(declared.manifest, this.#policy());
    if (violations.length > 0)
      throw new PsycheError(
        "policy_denied",
        `skill ${a.name} asks for more than the policy allows: ${violations.join("; ")}`,
        {
          details: { name: a.name, violations, manifest: declared.manifest },
        },
      );
    const findings = scanSkillTree(a.tree, a.name);
    if (hasBlockingFindings(findings))
      throw new PsycheError("policy_denied", `the scan of ${a.name} has high-severity findings`);
    const hash = treeHash(a.tree);
    const target = join(this.#o.homeDir, a.name);
    this.#busy = true;
    try {
      if (a.update) this.#retire(a.name, "update");
      writeTree(this.#o.homeDir, target, a.tree);
      this.#writeInstall(
        {
          id: "",
          name: a.name,
          source: { kind: "path", path: `agent/${a.name}` },
          text: text ?? "",
          hash,
          trust: "unknown",
          findings,
          approvalKind: "skill_install",
          files: [],
          scope: "home",
          bindingHash: "sha256:" as never,
          grantKey: "",
          expiresAt: 0,
          manifest: declared.manifest,
          author: "agent",
        },
        a.approvalId,
        target,
      );
    } finally {
      this.#busy = false;
    }
    await this.#o.broker?.recordReceipt({
      kind: "skill_install",
      outcome: "ok",
      summary: `${a.update ? "Updated" : "Installed"} skill ${a.name} (made by Psyche)`,
      approvalId: a.approvalId,
      externalRefs: { skill: a.name, hash },
    });
    this.refresh();
    this.#o.onChange?.({ type: "installed", name: a.name, hash, enabled: true });
    const e = this.#entries.find((x) => x.details.name === a.name && x.details.source === "home");
    if (e === undefined) throw new PsycheError("internal", "installed skill did not load");
    return toSummary(e.details);
  }

  /** Removes an agent-made skill after the owner approved the delete; keeps its last version. */
  async removeAgentSkill(name: string): Promise<void> {
    if (this.agentOwned(name) === undefined)
      throw new PsycheError("not_found", `no skill made by Psyche named ${name}`);
    this.#retire(name, "delete");
    await this.remove(name);
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
    const removedRole = lock.skills[k]?.manifest?.specialist?.role;
    delete lock.skills[k];
    writeLock(this.lockPath, lock);
    if (removedRole !== undefined) this.#o.onSpecialistReset?.(removedRole);
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
      if (lk.scope !== "home" || lk.origin.kind === "workspace" || lk.author === "agent") continue;
      // A file the owner chose has no address to re-read; they import the new file instead.
      if (lk.origin.kind === "bundleFile") continue;
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
        const next =
          parsed?.ok === true
            ? manifestOf(
                parsed.skill.meta,
                fetched.tree,
                parsed.skill.frontmatter as Record<string, unknown>,
              )
            : undefined;
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
export function writeTree(
  root: string,
  target: string,
  tree: SkillTree,
  /** Replaces `renameSync` (tests make the last rename fail). */
  rename: (from: string, to: string) => void = renameSync,
): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Hidden staging folder: discovery skips dot-folders, so a crash leaves nothing loadable.
  const stamp = `${process.pid}-${Date.now()}`;
  const staging = join(root, ".staging", `${basename(target)}-${stamp}`);
  const old = join(root, ".staging", `old-${basename(target)}-${stamp}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    for (const [path, f] of tree) {
      const abs = join(staging, path);
      mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
      writeFileSync(abs, f.bytes, { mode: f.executable ? 0o755 : 0o644, flag: "wx" });
    }
    const hadOld = existsSync(target);
    if (hadOld) rename(target, old);
    try {
      rename(staging, target);
    } catch (err) {
      // The new tree could not be put in place: the installed one goes back, never lost.
      if (hadOld && !existsSync(target)) rename(old, target);
      throw err;
    }
  } finally {
    // A failed write leaves no half-built folder behind; a swapped-out old tree is dropped too.
    rmSync(staging, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
}
