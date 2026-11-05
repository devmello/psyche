import { readFileSync } from "node:fs";
import {
  type ApprovalRequest,
  type BrowserTeachStep,
  type PermissionBroker,
  PsycheError,
  type SkillAuthor,
  type SkillDraft,
  type SkillDraftStatus,
  type SkillInstallSource,
  type SkillSource,
  type SkillSummary,
  type SkillUpdateCheck,
  type Surface,
} from "@psyche/protocol";
import type { SkillDrafts } from "./drafts.ts";
import type { FsSkillLoader, SkillDetails, SkillProposal } from "./loader.ts";
import type { SkillCommand } from "./prompt.ts";
import { summarizeFindings } from "./scanner.ts";

/**
 * `skills.*` method handlers. The wire schemas are proposed in a `protocol:` PR; until it merges
 * the Gateway registers these with the types below. Reads need `operator.read`; every mutation
 * needs `operator.admin` (skills are an admin setting root, protocol `isAdminSettingKey`).
 * Installing is a proposal: `skills.proposeInstall` fetches, scans and opens a `skill_install`
 * approval card on the owner's devices; `skills.install` runs only with that approval.
 */
export interface SkillsHandlers {
  "skills.list": () => Promise<{ skills: SkillDetails[] }>;
  "skills.get": (p: {
    name: string;
    source?: SkillSource;
  }) => Promise<{ skill: SkillDetails; text: string | null }>;
  "skills.search": (p: { query: string; limit?: number }) => Promise<{ skills: SkillSummary[] }>;
  "skills.commands": () => Promise<{ commands: SkillCommand[] }>;
  "skills.proposeInstall": (
    p: { source: SkillInstallSource; trustAuthor?: boolean },
    call?: unknown,
  ) => Promise<ProposalResult>;
  "skills.proposeUpdate": (
    p: { name: string; ref?: string; trustAuthor?: boolean },
    call?: unknown,
  ) => Promise<ProposalResult>;
  "skills.proposeApproval": (p: { name: string }) => Promise<ProposalResult>;
  "skills.install": (
    p: { proposalId: string; approvalId: string; trustApprovalId?: string },
    call?: unknown,
  ) => Promise<{ skill: SkillSummary }>;
  "skills.proposeImport": (
    p: { name: string; text: string; trustAuthor?: boolean },
    call?: unknown,
  ) => Promise<ProposalResult>;
  "skills.export": (
    p: { name: string; authorName?: string; approvalId?: string },
    call?: unknown,
  ) => Promise<{
    filename: string;
    bundle: string;
    signer: { keyId: string; name: string };
    createdKey: boolean;
  }>;
  "skills.authors.list": () => Promise<{
    own?: { keyId: string; name: string };
    authors: SkillAuthor[];
  }>;
  "skills.authors.set": (
    p: { keyId: string; state: "seen" | "trusted" | "revoked"; approvalId?: string },
    call?: unknown,
  ) => Promise<{ author: SkillAuthor }>;
  "skills.setEnabled": (p: {
    name: string;
    enabled: boolean;
    source?: SkillSource;
  }) => Promise<{ skill: SkillDetails }>;
  "skills.remove": (p: { name: string }) => Promise<{ ok: true }>;
  "skills.checkUpdates": (p: { name?: string }) => Promise<{ updates: SkillUpdateCheck[] }>;
  "skills.drafts.list": (p: { status?: SkillDraftStatus }) => Promise<{ drafts: SkillDraft[] }>;
  "skills.drafts.update": (p: { draftId: string; text: string }) => Promise<{ draft: SkillDraft }>;
  "skills.drafts.accept": (p: {
    draftId: string;
  }) => Promise<ProposalResult & { draft: SkillDraft }>;
  "skills.drafts.fromRecording": (p: {
    title: string;
    steps: BrowserTeachStep[];
    /** Set by the Gateway from the connection, never from the client. */
    device?: string;
  }) => Promise<{ draft: SkillDraft }>;
  "skills.drafts.dismiss": (p: { draftId: string }) => Promise<{ draft: SkillDraft }>;
  /** The staged proposal (full text, files, findings, diff) for an approval card on any device. */
  "skills.getProposal": (p: { proposalId: string }) => Promise<{ proposal: SkillProposal }>;
}

export interface ProposalResult {
  proposal: SkillProposal;
  approval: ApprovalRequest;
}

export interface SkillsHandlerOptions {
  broker: PermissionBroker;
  /** Surfaces for the approval card; `skill_install` is device-only, chat surfaces are dropped. */
  surfaces?: Surface[];
  /** Called for every installed skill whose source has an update (the Gateway's `skills.updated`). */
  onUpdate?: (update: SkillUpdateCheck) => void;
  /** Agent-proposed skill drafts (T3); without it `skills.drafts.*` answer `unavailable`. */
  drafts?: SkillDrafts;
  /** The name of a paired device, for the approval card of a skill made from a recording. */
  deviceName?: (deviceId: string) => string | undefined;
  /**
   * The Gateway's gates for the two owner actions that use or loosen trust. Each resolves when
   * the owner's approval (fresh presence, a device-only card) for exactly that action is
   * consumed, and throws `approval_required` / `forbidden` otherwise. Without a gate the action
   * is refused: signing and loosening trust never run unguarded.
   */
  gates?: SkillsGates;
}

export interface SkillsGates {
  /** Signing a skill with the owner's author key. `call` is the Gateway's call object. */
  export?: (
    call: unknown,
    action: {
      name: string;
      treeHash: string;
      files: { path: string; bytes: number; executable: boolean }[];
      origin: string;
      authorName?: string;
    },
    approvalId: string | undefined,
  ) => Promise<void>;
  /** Trusting a key, or moving one out of `revoked`. */
  authorChange?: (
    call: unknown,
    action: {
      keyId: string;
      from: string | undefined;
      to: string;
      /** The trust rides on a skill_install card the owner is approving right now. */
      via?: "install";
    },
    approvalId: string | undefined,
  ) => Promise<void>;
}

/**
 * Text from a bundle (an author's name) as it goes into an approval summary: quoted, control and
 * direction characters removed, short, so it cannot pose as the words around it.
 */
export function quoteForSummary(text: string, max = 40): string {
  const plain = [...text]
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      const bad =
        c < 0x20 ||
        (c >= 0x7f && c <= 0x9f) ||
        (c >= 0x200b && c <= 0x200f) ||
        (c >= 0x202a && c <= 0x202e) ||
        (c >= 0x2066 && c <= 0x2069) ||
        c === 0xfeff ||
        QUOTE_LIKE.has(ch);
      return bad ? " " : ch;
    })
    .join("");
  const t = plain.replace(/\s+/g, " ").trim();
  return `"${t.length > max ? `${t.slice(0, max)}…` : t}"`;
}

/** Every character that reads as a quotation mark, an apostrophe, a prime or a backtick. */
const QUOTE_LIKE = new Set(
  [
    "\"'`\\",
    "\u00ab\u00bb\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f\u2039\u203a",
    "\u2032\u2033\u2034\u2035\u2036\u2037\u2057\u02ba\u02dd\u02ee\u02bb\u02bc\u02bd",
    "\uff02\uff07\uff40\u00b4\u02cb\u0060\u2758\u2759\u275b\u275c\u275d\u275e\u275f",
    "\u2760\u276e\u276f\u301d\u301e\u301f\u2e42\u00b4\u02c8\u02ca\u055a\u05f3\u05f4",
  ].join(""),
);

export function createSkillsHandlers(
  loader: FsSkillLoader,
  opts: SkillsHandlerOptions,
): SkillsHandlers {
  const requestApproval = async (
    proposal: SkillProposal,
    proposedBy?: "agent" | "recording",
    recordedOn?: string,
    tainted = false,
  ): Promise<ProposalResult> => {
    const counts = summarizeFindings(proposal.findings);
    const verb =
      proposedBy === "agent"
        ? "Install skill Psyche proposed"
        : proposedBy === "recording"
          ? `Install skill from your recording${
              recordedOn === undefined
                ? ""
                : ` (made on ${opts.deviceName?.(recordedOn) ?? recordedOn})`
            }`
          : proposal.scope === "workspace"
            ? "Approve workspace skill"
            : proposal.update !== undefined
              ? "Update skill"
              : "Install skill";
    const sg = proposal.bundle?.signer;
    // The status comes first and is ours; the author's name is quoted text after it.
    const signerNote =
      sg === undefined
        ? ""
        : sg.status === "unsigned"
          ? " (unsigned bundle)"
          : ` (${sg.impersonates === true ? "name matches yours, key does not" : sg.status === "changed" ? "key changed" : sg.status}; signed by ${quoteForSummary(sg.name ?? "unknown")})`;
    const trustNote = proposal.trustAuthor === true ? " (also trusts this author)" : "";
    const widenedNote =
      proposal.update?.widened === undefined ? "" : " (asks for more than before)";
    const issued = await opts.broker.requestApproval({
      kind: "skill_install",
      summary: `${verb} "${proposal.name}"${signerNote}${trustNote}${widenedNote}${counts.high > 0 ? ` (${counts.high} high-severity findings: it will stay disabled)` : ""}`,
      details: {
        name: proposal.name,
        ...(proposedBy === undefined ? {} : { proposedBy }),
        ...(recordedOn === undefined
          ? {}
          : { recordedOn, recordedOnName: opts.deviceName?.(recordedOn) ?? recordedOn }),
        ...(proposal.author === "recording"
          ? {
              untrustedText:
                "This skill was made from pages you visited. Its steps quote text from those pages as data; it will be treated as untrusted instructions, and every action it takes still asks as usual.",
            }
          : tainted
            ? {
                untrustedText:
                  "This skill was drafted from work that had read content from outside Psyche. Treat its text as untrusted; every action it takes still asks as usual.",
              }
            : {}),
        scope: proposal.scope,
        source: proposal.source,
        ...(proposal.commit === undefined ? {} : { commit: proposal.commit }),
        hash: proposal.hash,
        // What the skill asks for: the trust card lists these first (`none` when empty).
        permissions: proposal.manifest.permissions,
        tools: proposal.manifest.tools,
        prompts: proposal.manifest.prompts,
        trust: proposal.trust,
        ...(sg === undefined
          ? {}
          : {
              signerStatus: sg.status,
              ...(sg.keyId === undefined ? {} : { signerKey: sg.keyId }),
              ...(sg.name === undefined ? {} : { signerName: sg.name }),
              origin: proposal.bundle?.origin,
            }),
        ...(proposal.trustAuthor === true ? { trustAuthor: true } : {}),
        ...(proposal.update?.widened === undefined ? {} : { widened: proposal.update.widened }),
        findings: counts,
        files: proposal.files.map((f) => f.path),
        ...(proposal.update === undefined ? {} : { fromHash: proposal.update.fromHash }),
      },
      bindingHash: proposal.bindingHash,
      grantKey: proposal.grantKey,
      requestedBy: { runId: null, taskId: null, threadId: null },
      // Destructive class: `once` only and device-only, so a channel message cannot approve it.
      sideEffect: "destructive",
      // Device surfaces only: a chat channel (`telegram:123`) can never approve an install.
      surfaces: (opts.surfaces ?? ["desktop"]).filter((x) => !x.includes(":")),
      scopesOffered: ["once"],
      // A skill made from a recording carries web page text: the card says so, in plain words.
      ...(proposal.author === "recording"
        ? { taint: true, taintSources: [{ sourceKind: "recorded web pages" }] }
        : tainted
          ? { taint: true, taintSources: [{ sourceKind: "content read in the conversation" }] }
          : { taint: false }),
    });
    return { proposal, approval: issued.approval };
  };

  const needDrafts = (): SkillDrafts => {
    if (opts.drafts === undefined)
      throw new PsycheError("unavailable", "agent-proposed skills are not set up");
    return opts.drafts;
  };

  const trustOf = (v: boolean | undefined) => (v === true ? { trustAuthor: true } : {});
  return {
    async "skills.list"() {
      return { skills: await loader.listDetailed() };
    },
    async "skills.get"(p) {
      const all = await loader.listDetailed();
      const skill = all.find(
        (s) => s.name === p.name && (p.source === undefined || s.source === p.source),
      );
      if (skill === undefined) throw new PsycheError("not_found", `no skill named ${p.name}`);
      let text: string | null = null;
      try {
        text = readFileSync(skill.path, "utf8");
      } catch {
        text = null;
      }
      return { skill, text };
    },
    async "skills.search"(p) {
      return { skills: await loader.search(p.query, p.limit) };
    },
    async "skills.commands"() {
      return { commands: await loader.commands() };
    },
    async "skills.proposeInstall"(p) {
      return requestApproval(await loader.proposeInstall(p.source, trustOf(p.trustAuthor)));
    },
    async "skills.proposeUpdate"(p) {
      return requestApproval(await loader.proposeUpdate(p.name, p.ref, trustOf(p.trustAuthor)));
    },
    async "skills.proposeApproval"(p) {
      return requestApproval(await loader.proposeWorkspaceApproval(p.name));
    },
    async "skills.install"(p, call) {
      // "Also trust this author" is a loosening of trust: it needs the same presence gate as
      // trusting a key from Settings, before anything is installed or trusted.
      const staged = loader.getProposal(p.proposalId);
      const keyId = staged?.bundle?.signer.keyId;
      if (staged?.trustAuthor === true && keyId !== undefined) {
        const gate = opts.gates?.authorChange;
        if (gate === undefined)
          throw new PsycheError("unavailable", "changing trust needs the Gateway's approval gate");
        await gate(
          call,
          { keyId, from: loader.authorState(keyId), to: "trusted", via: "install" },
          p.trustApprovalId,
        );
      }
      return { skill: await loader.install(p.proposalId, p.approvalId) };
    },
    async "skills.proposeImport"(p) {
      return requestApproval(await loader.proposeImport(p.name, p.text, trustOf(p.trustAuthor)));
    },
    async "skills.export"(p, call) {
      const pre = loader.previewExport(p.name);
      // The first export names the key's owner; refuse before a card is shown for nothing.
      if (!loader.hasAuthorKey() && (p.authorName === undefined || p.authorName.trim() === ""))
        throw new PsycheError(
          "invalid_params",
          "Choose the name to sign your skills with; everyone who imports them sees it",
        );
      const gate = opts.gates?.export;
      if (gate === undefined)
        throw new PsycheError("unavailable", "exporting needs the Gateway's approval gate");
      await gate(
        call,
        {
          name: pre.name,
          treeHash: pre.treeHash,
          files: pre.files,
          origin: pre.origin,
          ...(p.authorName === undefined ? {} : { authorName: p.authorName }),
        },
        p.approvalId,
      );
      return await loader.exportSkill(p.name, p.authorName, pre.treeHash);
    },
    async "skills.authors.list"() {
      return loader.authors();
    },
    async "skills.authors.set"(p, call) {
      const from = loader.authorState(p.keyId);
      // Tightening (un-trust, revoke) is always allowed; loosening needs the owner's presence.
      const loosening =
        p.state === "trusted" ? from !== "trusted" : from === "revoked" && p.state !== "revoked";
      if (loosening) {
        const gate = opts.gates?.authorChange;
        if (gate === undefined)
          throw new PsycheError("unavailable", "changing trust needs the Gateway's approval gate");
        await gate(call, { keyId: p.keyId, from, to: p.state }, p.approvalId);
      }
      return { author: loader.setAuthorState(p.keyId, p.state) };
    },
    async "skills.setEnabled"(p) {
      return { skill: await loader.setEnabled(p.name, p.enabled, p.source) };
    },
    async "skills.getProposal"(p) {
      const proposal = loader.getProposal(p.proposalId);
      if (proposal === undefined) throw new PsycheError("not_found", "no such install proposal");
      return { proposal };
    },
    async "skills.checkUpdates"(p) {
      const updates = await loader.checkUpdates(p.name);
      for (const u of updates) if (u.updateAvailable) opts.onUpdate?.(u);
      return { updates };
    },
    async "skills.drafts.list"(p) {
      return { drafts: opts.drafts?.list(p.status) ?? [] };
    },
    async "skills.drafts.update"(p) {
      return { draft: needDrafts().update(p.draftId, p.text) };
    },
    async "skills.drafts.accept"(p) {
      const drafts = needDrafts();
      const accepted = await drafts.accept(p.draftId);
      const made = drafts.get(p.draftId);
      // Taint is decided from the draft record, never from the text the owner can edit.
      const proposal =
        made.origin === "recording"
          ? loader.markProposalAuthor(accepted.proposal.id, "recording")
          : accepted.proposal;
      const result = await requestApproval(
        proposal,
        made.origin === "recording" ? "recording" : "agent",
        made.recordedOn,
        made.tainted,
      );
      const draft = drafts.accepted(p.draftId, proposal.id, result.approval.id);
      return { ...result, draft };
    },
    async "skills.drafts.fromRecording"(p) {
      return { draft: needDrafts().proposeFromRecording(p) };
    },
    async "skills.drafts.dismiss"(p) {
      return { draft: needDrafts().dismiss(p.draftId) };
    },
    async "skills.remove"(p) {
      await loader.remove(p.name);
      return { ok: true };
    },
  };
}
