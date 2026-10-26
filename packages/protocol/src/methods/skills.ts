import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Sha256, SideEffect, StringEnum } from "../common.ts";
import { ApprovalKind, ApprovalRequest } from "../schemas/permissions.ts";
import { defineMethod, EmptyParams, OkResult } from "./define.ts";

/**
 * `skills.*` (architecture §13; features T1, T2; security §11; owner S16, `packages/skills`).
 * Reads need `operator.read`; every mutation needs `operator.admin` (skills are an admin setting
 * root). Installing is a proposal: `skills.proposeInstall` fetches, scans and opens a device-only
 * `skill_install` approval card; `skills.install` runs only with that approval. The JSON forms of
 * the `SkillLoader` contract types (`contracts/SkillLoader.ts`) carry a `Schema` suffix.
 */

/** Skill folder name (`SKILL.md` frontmatter `name`): lowercase words joined by `-`. */
export const SkillName = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
});

export const SkillSourceSchema = StringEnum(["workspace", "home", "bundled"], {
  $id: "SkillSource",
});

export const SkillTrustSchema = StringEnum(["bundled", "verified", "local", "unknown"], {
  $id: "SkillTrust",
});

/** Why a skill is or is not offered to the model (Settings → Skills status column). */
export const SkillStatus = StringEnum(
  [
    "active",
    "disabled",
    "draft",
    "unlocked",
    "hash_mismatch",
    "invalid",
    "blocked",
    "ineligible",
    "shadowed",
  ],
  { $id: "SkillStatus" },
);
export type SkillStatus = Static<typeof SkillStatus>;

export const SkillSummarySchema = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    source: SkillSourceSchema,
    path: Type.String(),
    trust: SkillTrustSchema,
    userInvocable: Type.Boolean(),
    disableModelInvocation: Type.Boolean(),
    enabled: Type.Boolean({ description: "Effective state: the owner's switch and the gates" }),
    hash: Type.String({ description: "Tree hash; empty for a skill that could not be read" }),
  },
  { $id: "SkillSummary" },
);

export const ScanFindingSchema = Type.Object(
  {
    rule: Type.String(),
    severity: StringEnum(["info", "warn", "high"]),
    message: Type.String({ description: "Never quotes the matched text" }),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    file: Type.Optional(Type.String({ description: "Path inside the skill folder" })),
  },
  { $id: "ScanFinding" },
);

/**
 * What a skill declares it needs (feature T2): the tools it uses (`allowed-tools`,
 * `requires.tools`, `requires.anyTools`), the approval kinds it expects to request (frontmatter
 * `permissions`) and the prompt files it ships (frontmatter `prompts`, paths inside the folder).
 * The trust card shows it, the `skill_install` binding covers it, and an install whose manifest
 * asks for more than the owner's policy allows is refused with `policy_denied` before any card.
 * Declaring a tool never grants it: an approved skill never widens tool policy (security §11).
 */
export const SkillManifest = Type.Object(
  {
    tools: Type.Array(Type.String(), {
      description: "Tool names or `family.*` globs, sorted, without duplicates",
    }),
    permissions: Type.Array(ApprovalKind, {
      description: "Approval kinds the skill expects its steps to request, sorted",
    }),
    prompts: Type.Array(Type.String(), {
      description: "Prompt files inside the skill folder (relative paths), sorted",
    }),
  },
  { $id: "SkillManifest" },
);
export type SkillManifest = Static<typeof SkillManifest>;

/** Update detection for an installed skill: its pinned source re-fetched and hashed. */
export const SkillUpdateStatus = Type.Object(
  {
    name: Type.String(),
    installedHash: Type.String(),
    availableHash: Type.Optional(
      Type.String({ description: "Tree hash at the source; absent when the check failed" }),
    ),
    commit: Type.Optional(Type.String({ description: "Git sources: the commit the ref names" })),
    updateAvailable: Type.Boolean(),
    manifestChanged: Type.Boolean({
      description: "The update declares different tools, permissions or prompts",
    }),
    error: Type.Optional(Type.String({ description: "Why the source could not be checked" })),
    checkedAt: Type.Integer({ minimum: 0, description: "Epoch ms" }),
  },
  { $id: "SkillUpdateStatus" },
);
export type SkillUpdateStatus = Static<typeof SkillUpdateStatus>;

/** A skill as Settings → Skills shows it. */
export const SkillDetails = Type.Object(
  {
    ...SkillSummarySchema.properties,
    status: SkillStatus,
    reasons: Type.Array(Type.String()),
    findings: Type.Array(ScanFindingSchema),
    userEnabled: Type.Boolean({
      description: "The owner's switch (`enabled` is the effective state)",
    }),
    overrides: Type.Array(SkillSourceSchema, {
      description: "Lower-precedence sources this skill overrides",
    }),
    version: Type.Optional(Type.String()),
    commit: Type.Optional(Type.String()),
    manifest: Type.Optional(SkillManifest),
    update: Type.Optional(SkillUpdateStatus),
  },
  { $id: "SkillDetails" },
);
export type SkillDetails = Static<typeof SkillDetails>;

export const SkillInstallSourceSchema = Type.Union(
  [
    Type.Object({ kind: Type.Literal("path"), path: Type.String({ minLength: 1 }) }),
    Type.Object({
      kind: Type.Literal("git"),
      url: Type.String({ minLength: 1, maxLength: 2048 }),
      ref: Type.String({ minLength: 1, maxLength: 256 }),
    }),
    Type.Object({ kind: Type.Literal("zip"), path: Type.String({ minLength: 1 }) }),
  ],
  { $id: "SkillInstallSource" },
);

export const SkillProposalFile = Type.Object(
  {
    path: Type.String(),
    bytes: Type.Integer({ minimum: 0 }),
    executable: Type.Boolean(),
    text: Type.Optional(Type.String({ description: "Absent for binary files" })),
  },
  { $id: "SkillProposalFile" },
);
export type SkillProposalFile = Static<typeof SkillProposalFile>;

/** A staged install, update or workspace approval; the approval card shows all of it. */
export const SkillProposal = Type.Object(
  {
    id: Id,
    name: Type.String(),
    source: SkillInstallSourceSchema,
    text: Type.String({ description: "Full `SKILL.md` text, shown before enabling" }),
    hash: Type.String(),
    trust: SkillTrustSchema,
    findings: Type.Array(ScanFindingSchema),
    approvalKind: Type.Literal("skill_install"),
    files: Type.Array(SkillProposalFile, {
      description: "Every file of the skill (security §11)",
    }),
    scope: StringEnum(["home", "workspace"]),
    bindingHash: Sha256,
    grantKey: Type.String(),
    commit: Type.Optional(Type.String()),
    update: Type.Optional(
      Type.Object(
        {
          fromHash: Type.String(),
          upToDate: Type.Boolean(),
          diff: Type.String({ description: "Unified diff per file" }),
        },
        { description: "Updates and re-approvals: the installed hash and the diff" },
      ),
    ),
    expiresAt: Type.Integer({ minimum: 0, description: "Epoch ms" }),
    manifest: Type.Optional(SkillManifest),
  },
  { $id: "SkillProposal" },
);
export type SkillProposal = Static<typeof SkillProposal>;

/** A user-invocable skill as a composer slash command. */
export const SkillCommandSchema = Type.Object(
  {
    command: Type.String({ pattern: "^/", description: "`/inbox-triage`" }),
    name: Type.String(),
    description: Type.String(),
    source: SkillSourceSchema,
    trust: SkillTrustSchema,
  },
  { $id: "SkillCommand" },
);

/** What the loader reports when skills change on disk or through `skills.*`. */
export const SkillChangeEvent = Type.Union(
  [
    Type.Object({
      type: Type.Literal("reloaded"),
      added: Type.Array(Type.String()),
      removed: Type.Array(Type.String()),
      changed: Type.Array(Type.String()),
    }),
    Type.Object({
      type: Type.Literal("hash_mismatch"),
      name: Type.String(),
      source: SkillSourceSchema,
      path: Type.String(),
    }),
    Type.Object({
      type: Type.Literal("installed"),
      name: Type.String(),
      hash: Type.String(),
      enabled: Type.Boolean(),
    }),
    Type.Object({
      type: Type.Literal("removed"),
      name: Type.String(),
      source: SkillSourceSchema,
    }),
  ],
  { $id: "SkillChangeEvent" },
);
export type SkillChangeEvent = Static<typeof SkillChangeEvent>;

/**
 * Agent-proposed skills (feature T3; security §11 "Agent-proposed skills stay drafts until
 * accepted"). When the agent notices a routine repeated in one thread, the Gateway drafts a skill
 * from it: tool names and input names only, the owner's words with secrets and personal data
 * stripped. A draft is never installed by itself: the owner edits, accepts (a replay check, then
 * the T2 trust card and `skill_install` approval like any install) or dismisses it.
 */
export const SkillDraftStatus = StringEnum(
  ["open", "accepted", "installed", "dismissed", "expired"],
  { $id: "SkillDraftStatus" },
);
export type SkillDraftStatus = Static<typeof SkillDraftStatus>;

export const SkillDraftStep = Type.Object(
  {
    tool: Type.String(),
    sideEffect: SideEffect,
    summary: Type.String({ description: "Input names only, never values" }),
  },
  { $id: "SkillDraftStep" },
);
export type SkillDraftStep = Static<typeof SkillDraftStep>;

/** The replay check at accept time: the routine still runs with today's tools and policy. */
export const SkillDraftReplay = Type.Object(
  {
    ok: Type.Boolean(),
    problems: Type.Array(Type.String()),
    checkedAt: IsoDateTime,
  },
  { $id: "SkillDraftReplay" },
);
export type SkillDraftReplay = Static<typeof SkillDraftReplay>;

export const SkillDraft = Type.Object(
  {
    id: Id,
    threadId: Id,
    name: Type.String(),
    description: Type.String(),
    text: Type.String({ description: "Full SKILL.md, editable by the owner while open" }),
    manifest: SkillManifest,
    steps: Type.Array(SkillDraftStep),
    occurrences: Type.Integer({ minimum: 2, description: "Runs in the thread with this routine" }),
    signature: Sha256,
    redactions: Type.Integer({ minimum: 0, description: "Values stripped from the owner's words" }),
    tainted: Type.Boolean({ description: "A run of the routine had read untrusted content" }),
    edited: Type.Boolean(),
    status: SkillDraftStatus,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    installProposalId: Type.Optional(Id),
    approvalId: Type.Optional(Id),
    replay: Type.Optional(SkillDraftReplay),
    /**
     * Set on an update of an installed skill that folds in what the owner taught it
     * (docs/agent/teaching-loop-2026.md §6): the skill, the hash the draft was made from, the
     * lessons folded in, and the lines added to its `acceptance.md`.
     */
    update: Type.Optional(
      Type.Object({
        skill: Type.String(),
        baseHash: Sha256,
        lessonIds: Type.Array(Id, { maxItems: 50 }),
        acceptance: Type.Array(Type.String({ maxLength: 400 }), { maxItems: 50 }),
      }),
    ),
  },
  { $id: "SkillDraft" },
);
export type SkillDraft = Static<typeof SkillDraft>;

const ProposalResult = Type.Object(
  { proposal: SkillProposal, approval: ApprovalRequest },
  { $id: "SkillProposalResult" },
);

export const SkillsMethods = {
  "skills.list": defineMethod({
    params: EmptyParams,
    result: Type.Object({ skills: Type.Array(SkillDetails) }),
    scope: "operator.read",
    description: "Every discovered skill with status, findings and overrides (Settings → Skills).",
  }),
  "skills.get": defineMethod({
    params: Type.Object({ name: SkillName, source: Type.Optional(SkillSourceSchema) }),
    result: Type.Object({
      skill: SkillDetails,
      text: Type.Union([Type.String(), Type.Null()], {
        description: "`SKILL.md` text; null when it cannot be read",
      }),
    }),
    scope: "operator.read",
    description: "One skill and its SKILL.md text; the winning source unless `source` is given.",
  }),
  "skills.search": defineMethod({
    params: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2000 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    result: Type.Object({ skills: Type.Array(SkillSummarySchema) }),
    scope: "operator.read",
    description: "Skills whose name or description match the query.",
  }),
  "skills.commands": defineMethod({
    params: EmptyParams,
    result: Type.Object({ commands: Type.Array(SkillCommandSchema) }),
    scope: "operator.read",
    description: "Enabled user-invocable skills as composer slash commands.",
  }),
  "skills.getProposal": defineMethod({
    params: Type.Object({ proposalId: Id }),
    result: Type.Object({ proposal: SkillProposal }),
    scope: "operator.read",
    description:
      "The staged proposal (full text, files, findings, diff) for an approval card on any device.",
  }),
  "skills.proposeInstall": defineMethod({
    params: Type.Object({ source: SkillInstallSourceSchema }),
    result: ProposalResult,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: fetches and scans a skill and opens a device-only skill_install approval; policy_denied (details.violations) when its manifest asks for more than the policy allows.",
  }),
  "skills.proposeUpdate": defineMethod({
    params: Type.Object({
      name: SkillName,
      ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    }),
    result: ProposalResult,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: stages an update of an installed skill (with a diff) and opens a skill_install approval.",
  }),
  "skills.proposeApproval": defineMethod({
    params: Type.Object({ name: SkillName }),
    result: ProposalResult,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: opens a skill_install approval for a workspace skill draft or changed workspace skill.",
  }),
  "skills.install": defineMethod({
    params: Type.Object({ proposalId: Id, approvalId: Id }),
    result: Type.Object({ skill: SkillSummarySchema }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: installs a proposal; fails with approval_required without its approved skill_install.",
  }),
  "skills.setEnabled": defineMethod({
    params: Type.Object({
      name: SkillName,
      enabled: Type.Boolean(),
      source: Type.Optional(SkillSourceSchema),
    }),
    result: Type.Object({ skill: SkillDetails }),
    scope: "operator.admin",
    sideEffecting: true,
    description: "Side-effecting: sets the owner's switch for a skill.",
  }),
  "skills.checkUpdates": defineMethod({
    params: Type.Object({ name: Type.Optional(SkillName) }),
    result: Type.Object({ updates: Type.Array(SkillUpdateStatus) }),
    scope: "operator.admin",
    description:
      "Re-fetches installed skills from their pinned sources (no install) and reports which changed; emits skills.updated for each update found.",
  }),
  "skills.drafts.list": defineMethod({
    params: Type.Object({ status: Type.Optional(SkillDraftStatus) }),
    result: Type.Object({ drafts: Type.Array(SkillDraft) }),
    scope: "operator.read",
    description: "Skills the agent proposed from repeated routines (T3), newest first.",
  }),
  "skills.drafts.update": defineMethod({
    params: Type.Object({ draftId: Id, text: Type.String({ minLength: 1, maxLength: 65_536 }) }),
    result: Type.Object({ draft: SkillDraft }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: replaces an open draft's SKILL.md (the owner's edit); the manifest is re-read from it.",
  }),
  "skills.drafts.accept": defineMethod({
    params: Type.Object({ draftId: Id }),
    result: Type.Object({
      draft: SkillDraft,
      proposal: SkillProposal,
      approval: ApprovalRequest,
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: replays the draft against today's tools, then stages it like skills.proposeInstall (trust card, device-only skill_install approval); install with skills.install. policy_denied when the replay or the policy refuses it.",
  }),
  "skills.drafts.dismiss": defineMethod({
    params: Type.Object({ draftId: Id }),
    result: Type.Object({ draft: SkillDraft }),
    scope: "operator.admin",
    sideEffecting: true,
    description: "Side-effecting: dismisses a draft; the same routine is not proposed again.",
  }),
  "skills.remove": defineMethod({
    params: Type.Object({ name: SkillName }),
    result: OkResult,
    scope: "operator.admin",
    sideEffecting: true,
    description: "Side-effecting: removes an installed skill (receipt kind skill_remove).",
  }),
} as const;
