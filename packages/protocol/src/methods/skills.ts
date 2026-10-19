import { type Static, Type } from "@sinclair/typebox";
import { Id, Sha256, StringEnum } from "../common.ts";
import { ApprovalRequest } from "../schemas/permissions.ts";
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
      "Side-effecting: fetches and scans a skill and opens a device-only skill_install approval.",
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
  "skills.remove": defineMethod({
    params: Type.Object({ name: SkillName }),
    result: OkResult,
    scope: "operator.admin",
    sideEffecting: true,
    description: "Side-effecting: removes an installed skill (receipt kind skill_remove).",
  }),
} as const;
