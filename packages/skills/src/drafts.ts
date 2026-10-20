import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { inferApprovalKind } from "@psyche/permissions";
import {
  PsycheError,
  type SideEffect,
  type SkillDraft,
  type SkillDraftReplay,
  type SkillDraftStatus,
  type SkillDraftStep,
} from "@psyche/protocol";
import { stringify } from "yaml";
import { NAME_PATTERN, parseSkill } from "./frontmatter.ts";
import type { FsSkillLoader, SkillProposal } from "./loader.ts";
import { manifestOf } from "./manifest.ts";

/**
 * Agent-proposed skills (feature T3; security §11 "Agent-proposed skills stay drafts until
 * accepted"). Routine detection (agent-core's `attachRoutineDetector`) hands over a tool sequence
 * that ended the owner's turns more than once in one thread; this module turns it into a
 * `SKILL.md` draft and keeps the drafts:
 *
 * - **What a draft contains**: tool names, the names of their inputs (never values) and the
 *   owner's words with secrets and personal data stripped (the Gateway's vault and audit
 *   redactors, then emails, links and long numbers generalized here). Nothing the tools returned.
 * - **Never installed by itself**: accepting replays the draft against today's tools (it may not
 *   declare tools or approval kinds the routine never used, and every tool must still exist),
 *   then stages it from a quarantine folder (`.drafts/`, which the loader never reads) through
 *   the T2 path: scan, policy, trust card, device-only `skill_install` approval, lock.
 * - **Rate limits**: one proposal per thread per day, at most five open drafts, a dismissed or
 *   already proposed routine is never proposed again; open drafts expire after 14 days.
 * - **Audited**: every proposal, edit, accept, dismissal and install goes to the audit hook.
 */

export interface RoutineRun {
  runId: string;
  ownerText: string;
  taint: boolean;
  steps: { tool: string; sideEffect: SideEffect; params: unknown }[];
}

export interface RoutineInput {
  threadId: string;
  /** Tool names in order (consecutive repeats collapsed). */
  tools: string[];
  runs: RoutineRun[];
}

export interface SkillDraftsOptions {
  /** `$PSYCHE_HOME/skills/.drafts`: the store and the quarantine folders. */
  dir: string;
  loader: FsSkillLoader;
  /** Secret and personal-data redaction for the owner's words (vault + audit redactors). */
  redact?: (text: string) => string;
  /** Tools the agent can call now (the replay check); absent skips that check. */
  knownTools?: () => readonly string[];
  audit?: (entry: { kind: string; draftId: string; data: Record<string, unknown> }) => unknown;
  onUpdate?: (draft: SkillDraft) => void;
  now?: () => number;
  newId?: () => string;
  /** Default: one per thread per 24 h, five open, 14-day expiry. */
  limits?: { perThreadMs?: number; maxOpen?: number; ttlMs?: number };
}

interface StoreFile {
  version: 1;
  drafts: SkillDraft[];
  /** Routine signatures the owner dismissed: never proposed again. */
  dismissed: string[];
  /** Epoch ms of the last proposal per thread. */
  lastProposed: Record<string, number>;
}

const DAY = 24 * 60 * 60 * 1000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: flattening to one line is the point
const LINE_BREAKERS = /[\u0000-\u001f\u007f\u2028\u2029]+/g;
const MAX_TEXT = 200;
const STORE = "drafts.json";

const iso = (ms: number) => new Date(ms).toISOString();
const unique = (xs: Iterable<string>) => [...new Set(xs)].sort();

export function routineSignature(tools: readonly string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(`psyche.routine.v1|${tools.join(">")}`)
    .digest("hex")}`;
}

/** Input names of a call, never values: plain identifiers, at most eight. */
function inputNames(params: unknown): string[] {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return [];
  return Object.keys(params)
    .filter((k) => /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k))
    .slice(0, 8);
}

const EFFECT_WORDS: Record<SideEffect, string> = {
  none: "no side effect",
  read: "reads",
  write: "changes something; asks when policy says so",
  destructive: "deletes or overwrites; asks first",
  financial: "spends money; asks first",
};

const STOPWORDS = new Set(
  "a an and are as at be but by can could do for from get have i in into is it its me my of on or our please so that the their them then this to up us we what when with would you your again".split(
    " ",
  ),
);

export class SkillDrafts {
  #o: SkillDraftsOptions;
  #now: () => number;
  #newId: () => string;

  constructor(options: SkillDraftsOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#newId =
      options.newId ?? (() => `skd_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`);
  }

  // --- store -------------------------------------------------------------------------------------

  #path(): string {
    return join(this.#o.dir, STORE);
  }

  #read(): StoreFile {
    const p = this.#path();
    if (!existsSync(p)) return { version: 1, drafts: [], dismissed: [], lastProposed: {} };
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<StoreFile>;
      return {
        version: 1,
        drafts: Array.isArray(raw.drafts) ? raw.drafts : [],
        dismissed: Array.isArray(raw.dismissed) ? raw.dismissed : [],
        lastProposed: raw.lastProposed ?? {},
      };
    } catch (err) {
      throw new PsycheError("internal", `cannot read ${STORE}: ${(err as Error).message}`);
    }
  }

  #write(store: StoreFile): void {
    mkdirSync(this.#o.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.#path()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#path());
  }

  /** Expires stale open drafts; returns whether anything changed. */
  #expire(store: StoreFile): boolean {
    const ttl = this.#o.limits?.ttlMs ?? 14 * DAY;
    let changed = false;
    for (const d of store.drafts) {
      if (d.status === "open" && this.#now() - Date.parse(d.createdAt) > ttl) {
        d.status = "expired";
        d.updatedAt = iso(this.#now());
        changed = true;
        this.#emit(d, "skill.draft.expired");
      }
    }
    return changed;
  }

  #emit(draft: SkillDraft, kind: string, data: Record<string, unknown> = {}): void {
    try {
      this.#o.audit?.({ kind, draftId: draft.id, data: { name: draft.name, ...data } });
    } catch {
      // The audit hook observes; it cannot block a draft change.
    }
    this.#o.onUpdate?.(structuredClone(draft));
  }

  #find(store: StoreFile, id: string): SkillDraft {
    const d = store.drafts.find((x) => x.id === id);
    if (d === undefined) throw new PsycheError("not_found", "no such skill draft");
    return d;
  }

  list(status?: SkillDraftStatus): SkillDraft[] {
    const store = this.#read();
    if (this.#expire(store)) this.#write(store);
    return store.drafts
      .filter((d) => status === undefined || d.status === status)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map((d) => structuredClone(d));
  }

  get(id: string): SkillDraft {
    return structuredClone(this.#find(this.#read(), id));
  }

  // --- proposing -----------------------------------------------------------------------------

  /** Drafts a skill from a detected routine, or returns `undefined` when a limit says no. */
  propose(input: RoutineInput): SkillDraft | undefined {
    if (input.runs.length < 2 || input.tools.length === 0) return undefined;
    const store = this.#read();
    this.#expire(store);
    const signature = routineSignature(input.tools);
    if (store.dismissed.includes(signature)) return undefined;
    const same = store.drafts.find(
      (d) => d.signature === signature && d.status !== "expired" && d.status !== "dismissed",
    );
    if (same !== undefined) {
      // Already proposed (or installed): keep count, never propose twice.
      if (same.status === "open" && same.threadId === input.threadId) {
        same.occurrences = Math.max(same.occurrences, input.runs.length);
        same.updatedAt = iso(this.#now());
        this.#write(store);
      }
      return undefined;
    }
    const perThread = this.#o.limits?.perThreadMs ?? DAY;
    const last = store.lastProposed[input.threadId];
    if (last !== undefined && this.#now() - last < perThread) return undefined;
    const maxOpen = this.#o.limits?.maxOpen ?? 5;
    if (store.drafts.filter((d) => d.status === "open").length >= maxOpen) return undefined;

    const generated = this.#generate(input, signature, store);
    if (generated === undefined) return undefined;
    store.drafts.push(generated);
    store.lastProposed[input.threadId] = this.#now();
    this.#write(store);
    this.#emit(generated, "skill.draft.proposed", {
      threadId: input.threadId,
      occurrences: generated.occurrences,
      tools: generated.manifest.tools,
      redactions: generated.redactions,
    });
    return structuredClone(generated);
  }

  /** Owner text, redacted and generalized, one line, capped; with how many values it lost. */
  scrub(text: string): { text: string; redactions: number } {
    let s = this.#o.redact === undefined ? text : this.#o.redact(text);
    let redactions = (s.match(/•••|\[redacted[^\]]*\]/g) ?? []).length;
    const rules: [RegExp, string][] = [
      [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
      [/\bhttps?:\/\/\S+/gi, "<link>"],
      [/\+?\d[\d\s().-]{6,}\d/g, "<number>"],
      [/\b\d{5,}\b/g, "<number>"],
    ];
    for (const [re, placeholder] of rules) {
      s = s.replace(re, () => {
        redactions += 1;
        return placeholder;
      });
    }
    s = s.replace(LINE_BREAKERS, " ").replace(/\s+/g, " ").trim();
    if (s.length > MAX_TEXT) s = `${s.slice(0, MAX_TEXT)}…`;
    return { text: s, redactions };
  }

  #nameFor(text: string, signature: string, store: StoreFile): string {
    const words = text
      .toLowerCase()
      .replace(/<[a-z]+>|\[redacted[^\]]*\]|•••/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w))
      .slice(0, 4);
    let base = words.join("-").slice(0, 48).replace(/-+$/, "");
    if (!NAME_PATTERN.test(base)) base = `routine-${signature.slice(7, 13)}`;
    const taken = new Set([
      ...store.drafts
        .filter((d) => d.status !== "dismissed" && d.status !== "expired")
        .map((d) => d.name),
    ]);
    let name = base;
    for (let n = 2; taken.has(name) || this.#skillExists(name); n += 1) name = `${base}-${n}`;
    return name;
  }

  #skillExists(name: string): boolean {
    return this.#o.loader.names().includes(name);
  }

  #generate(
    input: RoutineInput,
    signature: `sha256:${string}`,
    store: StoreFile,
  ): SkillDraft | undefined {
    const latest = input.runs[input.runs.length - 1] as RoutineRun;
    const scrubbed = input.runs.map((r) => this.scrub(r.ownerText));
    const request = scrubbed[scrubbed.length - 1]?.text ?? "";
    const redactions = scrubbed.reduce((n, s) => n + s.redactions, 0);
    const name = this.#nameFor(request, signature, store);

    // One step per tool of the routine, with the input names seen in any of its runs.
    const steps: SkillDraftStep[] = [];
    let cursor = 0;
    for (const tool of input.tools) {
      const names = new Set<string>();
      let sideEffect: SideEffect = "none";
      for (const run of input.runs) {
        for (const s of run.steps)
          if (s.tool === tool) for (const k of inputNames(s.params)) names.add(k);
      }
      const at = latest.steps.findIndex((s, i) => i >= cursor && s.tool === tool);
      if (at >= 0) {
        sideEffect = latest.steps[at]?.sideEffect ?? "none";
        cursor = at + 1;
      }
      const inputs = [...names].slice(0, 8);
      steps.push({
        tool,
        sideEffect,
        summary: inputs.length === 0 ? "no inputs" : `inputs: ${inputs.join(", ")}`,
      });
    }
    const permissions = unique(
      steps
        .filter(
          (s) =>
            s.sideEffect === "write" ||
            s.sideEffect === "destructive" ||
            s.sideEffect === "financial",
        )
        .map((s) => inferApprovalKind(s.tool)),
    );
    const tools = unique(input.tools);
    const text = draftText({
      name,
      request,
      occurrences: input.runs.length,
      signature,
      steps,
      tools,
      permissions,
    });
    const parsed = parseSkill(text, name);
    if (!parsed.ok) return undefined;
    const manifest = manifestOf(parsed.skill.meta);
    if (!manifest.ok) return undefined;
    const now = iso(this.#now());
    return {
      id: this.#newId(),
      threadId: input.threadId,
      name,
      description: parsed.skill.meta.description,
      text,
      // `manifestOf` checked every permission against the approval kinds.
      manifest: manifest.manifest as SkillDraft["manifest"],
      steps,
      occurrences: input.runs.length,
      signature,
      redactions,
      tainted: input.runs.some((r) => r.taint),
      edited: false,
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
  }

  // --- owner actions -------------------------------------------------------------------------

  /** The owner's edit of an open draft; name, description and manifest are re-read from it. */
  update(id: string, text: string): SkillDraft {
    const store = this.#read();
    const d = this.#find(store, id);
    if (d.status !== "open") throw new PsycheError("conflict", `the draft is ${d.status}`);
    const parsed = parseSkill(text);
    if (!parsed.ok)
      throw new PsycheError("invalid_params", `not a valid skill: ${parsed.errors.join("; ")}`);
    const manifest = manifestOf(parsed.skill.meta);
    if (!manifest.ok)
      throw new PsycheError(
        "invalid_params",
        `invalid skill manifest: ${manifest.errors.join("; ")}`,
      );
    d.text = text;
    d.name = parsed.skill.meta.name;
    d.description = parsed.skill.meta.description;
    d.manifest = manifest.manifest as SkillDraft["manifest"];
    d.edited = true;
    d.updatedAt = iso(this.#now());
    delete d.replay;
    this.#write(store);
    this.#emit(d, "skill.draft.edited");
    return structuredClone(d);
  }

  /** The routine replayed against today's tools and the draft's own recorded needs. */
  replay(draft: SkillDraft): SkillDraftReplay {
    const problems: string[] = [];
    const recordedTools = new Set(draft.steps.map((s) => s.tool));
    const recordedKinds = new Set(
      draft.steps
        .filter(
          (s) =>
            s.sideEffect === "write" ||
            s.sideEffect === "destructive" ||
            s.sideEffect === "financial",
        )
        .map((s) => inferApprovalKind(s.tool)),
    );
    const extraTools = draft.manifest.tools.filter((t) => !recordedTools.has(t));
    if (extraTools.length > 0)
      problems.push(`declares tools the routine never used: ${extraTools.join(", ")}`);
    const extraKinds = draft.manifest.permissions.filter((p) => !recordedKinds.has(p as never));
    if (extraKinds.length > 0)
      problems.push(`asks for approval kinds the routine never needed: ${extraKinds.join(", ")}`);
    const known = this.#o.knownTools?.();
    if (known !== undefined) {
      const gone = [...recordedTools].filter((t) => !known.includes(t));
      if (gone.length > 0) problems.push(`tools no longer available: ${gone.join(", ")}`);
    }
    return { ok: problems.length === 0, problems, checkedAt: iso(this.#now()) };
  }

  /**
   * Replays the draft, then stages it from quarantine through the T2 install path. The caller
   * opens the `skill_install` card for the returned proposal and passes its id to `accepted`.
   */
  async accept(id: string): Promise<{ draft: SkillDraft; proposal: SkillProposal }> {
    const store = this.#read();
    const d = this.#find(store, id);
    if (d.status !== "open" && d.status !== "accepted")
      throw new PsycheError("conflict", `the draft is ${d.status}`);
    const replay = this.replay(d);
    d.replay = replay;
    d.updatedAt = iso(this.#now());
    this.#write(store);
    if (!replay.ok) {
      this.#emit(d, "skill.draft.replay_failed", { problems: replay.problems });
      throw new PsycheError(
        "policy_denied",
        `the draft does not replay: ${replay.problems.join("; ")}`,
        { details: { problems: replay.problems } },
      );
    }
    const folder = join(this.#o.dir, d.id, d.name);
    rmSync(join(this.#o.dir, d.id), { recursive: true, force: true });
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, "SKILL.md"), d.text, { mode: 0o600 });
    const proposal = await this.#o.loader.proposeInstall({ kind: "path", path: folder });
    return { draft: structuredClone(d), proposal };
  }

  /** Records the approval card opened for an accepted draft. */
  accepted(id: string, proposalId: string, approvalId: string): SkillDraft {
    const store = this.#read();
    const d = this.#find(store, id);
    d.status = "accepted";
    d.installProposalId = proposalId;
    d.approvalId = approvalId;
    d.updatedAt = iso(this.#now());
    this.#write(store);
    this.#emit(d, "skill.draft.accepted", { approvalId });
    return structuredClone(d);
  }

  dismiss(id: string): SkillDraft {
    const store = this.#read();
    const d = this.#find(store, id);
    if (d.status === "installed")
      throw new PsycheError("conflict", "the draft is installed; remove the skill instead");
    d.status = "dismissed";
    d.updatedAt = iso(this.#now());
    if (!store.dismissed.includes(d.signature)) store.dismissed.push(d.signature);
    this.#write(store);
    rmSync(join(this.#o.dir, d.id), { recursive: true, force: true });
    this.#emit(d, "skill.draft.dismissed");
    return structuredClone(d);
  }

  /** An install finished (the loader's `installed` event): the accepted draft is installed. */
  installed(name: string): SkillDraft | undefined {
    const store = this.#read();
    const d = store.drafts.find((x) => x.status === "accepted" && x.name === name);
    if (d === undefined) return undefined;
    d.status = "installed";
    d.updatedAt = iso(this.#now());
    this.#write(store);
    this.#emit(d, "skill.draft.installed");
    return structuredClone(d);
  }
}

function draftText(p: {
  name: string;
  request: string;
  occurrences: number;
  signature: string;
  steps: SkillDraftStep[];
  tools: string[];
  permissions: string[];
}): string {
  const description =
    p.request === ""
      ? `A routine of ${p.steps.length} steps the owner repeated.`
      : `Repeat the owner's routine for requests like: ${p.request}`;
  const frontmatter = stringify(
    {
      name: p.name,
      description: description.slice(0, 1000),
      "user-invocable": true,
      "allowed-tools": p.tools,
      permissions: p.permissions,
      metadata: {
        psyche: { proposedBy: "agent", routine: p.signature, occurrences: p.occurrences },
      },
    },
    { lineWidth: 0 },
  );
  const title = p.name
    .split("-")
    .map((w) => (w.length > 0 ? `${w[0]?.toUpperCase()}${w.slice(1)}` : w))
    .join(" ");
  const lines = [
    "---",
    frontmatter.trimEnd(),
    "---",
    "",
    `# ${title}`,
    "",
    `Proposed by Psyche after the same steps ran ${p.occurrences} times in one conversation. Check every step before accepting. Steps that change something still go through the usual approvals.`,
    "",
    "## When to use",
    "",
    p.request === ""
      ? "When the owner asks for this routine."
      : `When the owner asks for: ${p.request}`,
    "",
    "## Steps",
    "",
    ...p.steps.map(
      (s, i) =>
        `${i + 1}. Call \`${s.tool}\` (${EFFECT_WORDS[s.sideEffect]}) with ${s.summary === "no inputs" ? "no inputs" : s.summary.replace(/^inputs: /, "inputs ")}.`,
    ),
    "",
    "Use the values from the owner's current request; this skill keeps none from earlier runs.",
    "",
  ];
  return lines.join("\n");
}
