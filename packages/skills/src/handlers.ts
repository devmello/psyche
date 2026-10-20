import { readFileSync } from "node:fs";
import {
  type ApprovalRequest,
  type PermissionBroker,
  PsycheError,
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
  "skills.proposeInstall": (p: { source: SkillInstallSource }) => Promise<ProposalResult>;
  "skills.proposeUpdate": (p: { name: string; ref?: string }) => Promise<ProposalResult>;
  "skills.proposeApproval": (p: { name: string }) => Promise<ProposalResult>;
  "skills.install": (p: {
    proposalId: string;
    approvalId: string;
  }) => Promise<{ skill: SkillSummary }>;
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
}

export function createSkillsHandlers(
  loader: FsSkillLoader,
  opts: SkillsHandlerOptions,
): SkillsHandlers {
  const requestApproval = async (
    proposal: SkillProposal,
    proposedBy?: "agent",
  ): Promise<ProposalResult> => {
    const counts = summarizeFindings(proposal.findings);
    const verb =
      proposedBy === "agent"
        ? "Install skill Psyche proposed"
        : proposal.scope === "workspace"
          ? "Approve workspace skill"
          : proposal.update !== undefined
            ? "Update skill"
            : "Install skill";
    const issued = await opts.broker.requestApproval({
      kind: "skill_install",
      summary: `${verb} "${proposal.name}"${counts.high > 0 ? ` (${counts.high} high-severity findings: it will stay disabled)` : ""}`,
      details: {
        name: proposal.name,
        ...(proposedBy === undefined ? {} : { proposedBy }),
        scope: proposal.scope,
        source: proposal.source,
        ...(proposal.commit === undefined ? {} : { commit: proposal.commit }),
        hash: proposal.hash,
        // What the skill asks for: the trust card lists these first (`none` when empty).
        permissions: proposal.manifest.permissions,
        tools: proposal.manifest.tools,
        prompts: proposal.manifest.prompts,
        trust: proposal.trust,
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
      taint: false,
    });
    return { proposal, approval: issued.approval };
  };

  const needDrafts = (): SkillDrafts => {
    if (opts.drafts === undefined)
      throw new PsycheError("unavailable", "agent-proposed skills are not set up");
    return opts.drafts;
  };

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
      return requestApproval(await loader.proposeInstall(p.source));
    },
    async "skills.proposeUpdate"(p) {
      return requestApproval(await loader.proposeUpdate(p.name, p.ref));
    },
    async "skills.proposeApproval"(p) {
      return requestApproval(await loader.proposeWorkspaceApproval(p.name));
    },
    async "skills.install"(p) {
      return { skill: await loader.install(p.proposalId, p.approvalId) };
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
      const { proposal } = await drafts.accept(p.draftId);
      const result = await requestApproval(proposal, "agent");
      const draft = drafts.accepted(p.draftId, proposal.id, result.approval.id);
      return { ...result, draft };
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
