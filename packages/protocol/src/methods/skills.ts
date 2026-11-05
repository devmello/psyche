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
    specialist: Type.Optional(
      Type.Object(
        {
          role: Type.String(),
          label: Type.String(),
          model: Type.String(),
          maxMode: Type.String(),
          tools: Type.Array(Type.String()),
          deny: Type.Array(Type.String()),
          memory: Type.String(),
          budget: Type.Record(Type.String(), Type.Number()),
          caps: Type.Record(Type.String(), Type.Number()),
          result: Type.String(),
          planFirst: Type.Boolean(),
          approvals: Type.Array(Type.String()),
        },
        {
          description:
            "The background role the skill defines (metadata.psyche.specialist): part of what the skill asks for, so a wider role is a wider request",
        },
      ),
    ),
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

/**
 * One earlier approved version of a skill Psyche made (`$PSYCHE_HOME/skills/.history/<name>/<n>/`).
 * Versions are kept, never loaded; restoring one is a new proposal the owner approves.
 */
export const SkillAuthorVersion = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    hash: Type.String(),
    approvedAt: IsoDateTime,
    retiredAt: IsoDateTime,
    retiredBy: StringEnum(["update", "delete"]),
  },
  { $id: "SkillAuthorVersion" },
);
export type SkillAuthorVersion = Static<typeof SkillAuthorVersion>;

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
    signer: Type.Optional(
      Type.Object({
        keyId: Type.String(),
        name: Type.String(),
        state: StringEnum(["seen", "trusted", "revoked", "own"]),
      }),
    ),
    update: Type.Optional(SkillUpdateStatus),
    madeBy: Type.Optional(
      StringEnum(["agent", "recording"], {
        description:
          "Psyche wrote this skill on this Mac (self-extension), or it was made from a recording; trust stays unknown",
      }),
    ),
    bundleOrigin: Type.Optional(
      StringEnum(["workspace", "agent"], {
        description:
          "An imported bundle: where the sender says it came from (signed). Never madeBy, which is for this Mac",
      }),
    ),
    history: Type.Optional(
      Type.Array(SkillAuthorVersion, {
        description: "Earlier approved versions of an agent-made skill, newest first",
      }),
    ),
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
    Type.Object({
      kind: Type.Literal("bundleFile"),
      name: Type.String({ minLength: 1, maxLength: 200 }),
    }),
    Type.Object({
      kind: Type.Literal("bundleUrl"),
      url: Type.String({ minLength: 1, maxLength: 2048 }),
    }),
  ],
  {
    $id: "SkillInstallSource",
    description:
      "bundleFile: a .psyche-skill file the owner chose (name is for display); bundleUrl: one at an https URL (no redirect to http, size-capped)",
  },
);

/**
 * Who signed a shared bundle (docs/design/shared-bundles-2026.md section 4). `keyId` is the
 * `sha256:<hex>` fingerprint of the author's Ed25519 public key; `name` is the author's own
 * claim and is never trusted on its own.
 * - `unsigned`: no signature; installs as `unknown`.
 * - `own`: the owner's author key. `trusted`: a key the owner trusted before.
 * - `seen`: a key from an earlier install the owner did not trust. `new`: a key never seen.
 * - `changed`: the author's name was seen with a different key, or this skill was installed
 *   with a different key (or it was signed and now is not).
 * - `revoked`: a key the owner revoked.
 * - `rotated`: a key the owner has not trusted, whose rotation statement (signed by an earlier key
 *   the owner has met or installed this with) names it: same author, new key. It explains the
 *   change; it never trusts the new key.
 */
export const BundleSignerStatus = StringEnum(
  ["unsigned", "own", "trusted", "seen", "new", "changed", "revoked", "rotated"],
  { $id: "BundleSignerStatus" },
);
export type BundleSignerStatus = Static<typeof BundleSignerStatus>;

export const BundleSigner = Type.Object(
  {
    status: BundleSignerStatus,
    keyId: Type.Optional(Type.String({ description: "`sha256:<hex>` of the public key" })),
    name: Type.Optional(
      Type.String({ description: "The author's claimed name (data, not verified)" }),
    ),
    previousKeyId: Type.Optional(
      Type.String({ description: "The key seen before when status is `changed`" }),
    ),
    signerChanged: Type.Boolean({
      description:
        "Differs from the key this skill was installed with (or it was signed and is no longer)",
    }),
    nameChanged: Type.Optional(
      Type.Boolean({ description: "A trusted key now signs under a name not seen with it before" }),
    ),
    impersonates: Type.Optional(
      Type.Boolean({
        description: "The name looks like the owner's own author name, with another key",
      }),
    ),
    rotatedFrom: Type.Optional(
      Type.Object({
        keyId: Type.String(),
        state: StringEnum(["seen", "trusted", "revoked"]),
      }),
    ),
  },
  { $id: "BundleSigner" },
);
export type BundleSigner = Static<typeof BundleSigner>;

/** What a staged bundle import adds to the trust card. */
export const SkillBundleInfo = Type.Object(
  {
    signer: BundleSigner,
    createdAt: Type.String({ description: "The author's claimed time; not verified" }),
    bytes: Type.Integer({ minimum: 0 }),
    origin: StringEnum(["workspace", "agent"], {
      description:
        "Where the exporter says the skill came from (signed); a bundle never installs as local",
    }),
  },
  { $id: "SkillBundleInfo" },
);
export type SkillBundleInfo = Static<typeof SkillBundleInfo>;

/** An author key the Gateway has seen (`$PSYCHE_HOME/skills/authors.json`). */
export const SkillAuthor = Type.Object(
  {
    keyId: Type.String(),
    names: Type.Array(Type.String()),
    state: StringEnum(["seen", "trusted", "revoked"]),
    firstSeen: IsoDateTime,
    trustedAt: Type.Optional(IsoDateTime),
  },
  { $id: "SkillAuthor" },
);
export type SkillAuthor = Static<typeof SkillAuthor>;

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
          widened: Type.Optional(
            Type.Object(
              {
                tools: Type.Array(Type.String()),
                permissions: Type.Array(Type.String()),
                prompts: Type.Array(Type.String()),
                specialist: Type.Optional(
                  Type.Array(Type.String(), {
                    description: "Plain-text changes to the background role that make it wider",
                  }),
                ),
              },
              { description: "What the new version asks for that the installed one did not" },
            ),
          ),
          signerChanged: Type.Optional(Type.Boolean()),
        },
        { description: "Updates and re-approvals: the installed hash and the diff" },
      ),
    ),
    expiresAt: Type.Integer({ minimum: 0, description: "Epoch ms" }),
    manifest: Type.Optional(SkillManifest),
    author: Type.Optional(
      StringEnum(["agent", "recording"], {
        description:
          "Psyche wrote this skill (agent), or it was made from a recording of web pages (recording): its text carries page content, so it stays untrusted",
      }),
    ),
    bundle: Type.Optional(SkillBundleInfo),
    trustAuthor: Type.Optional(
      Type.Boolean({ description: "Approving this card also trusts the bundle's author key" }),
    ),
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
    /** `recording`: made from a demonstration the owner recorded (teach by showing). */
    origin: Type.Optional(StringEnum(["routine", "recording"], { $id: "SkillDraftOrigin" })),
    /** `recording`: the device the owner recorded on; the approval card names it. */
    recordedOn: Type.Optional(Type.String({ maxLength: 128 })),
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

/**
 * Teach by showing in the built-in browser (feature J8, phase 1; docs/design/teach-by-showing-2026.md).
 * The owner presses Record, does the task once and presses Stop; the review screen turns the
 * demonstration into these steps. A step names its target by accessibility role and name with a
 * selector as a fallback, never by pixels. Typed text is kept only when the owner chose to
 * (`keepValue`); a sensitive field (password, card, one-time code, ID number) never carries a value
 * at all (`sensitive`), and page text is quoted as untrusted data when the steps become a skill.
 * (The Mac-app recorder's shapes are `TeachStep` in `schemas/teach.ts`.)
 */
export const BrowserTeachStepKind = StringEnum(["navigate", "click", "type", "select", "press"], {
  $id: "BrowserTeachStepKind",
});
export type BrowserTeachStepKind = Static<typeof BrowserTeachStepKind>;

/** A named input a recorded value became (`recipient`, `from_date`): lowercase words with `_`. */
export const BrowserTeachInputName = Type.String({
  minLength: 1,
  maxLength: 40,
  pattern: "^[a-z][a-z0-9_]*$",
  $id: "BrowserTeachInputName",
});

export const BrowserTeachStep = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64 }),
    kind: BrowserTeachStepKind,
    url: Type.Optional(
      Type.String({ maxLength: 2048, description: "navigate: origin and path, no query" }),
    ),
    role: Type.Optional(Type.String({ maxLength: 64, description: "Accessibility role" })),
    name: Type.Optional(
      Type.String({ maxLength: 200, description: "Accessible name (untrusted page text)" }),
    ),
    selector: Type.Optional(Type.String({ maxLength: 300, description: "Fallback CSS selector" })),
    key: Type.Optional(Type.String({ maxLength: 40, description: "press: the key" })),
    sensitive: Type.Optional(
      Type.Boolean({ description: "The field is sensitive: no value is ever stored" }),
    ),
    keepValue: Type.Optional(
      Type.Boolean({ description: "The owner chose to keep the typed value as it is" }),
    ),
    value: Type.Optional(
      Type.String({
        maxLength: 500,
        description: "Only with keepValue, and never on a sensitive step",
      }),
    ),
    input: Type.Optional(
      Type.Object(
        {
          name: BrowserTeachInputName,
          description: Type.Optional(Type.String({ maxLength: 200 })),
        },
        { description: "The value is an input the agent asks for each run" },
      ),
    ),
  },
  { $id: "BrowserTeachStep" },
);
export type BrowserTeachStep = Static<typeof BrowserTeachStep>;

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
    params: Type.Object({
      source: SkillInstallSourceSchema,
      trustAuthor: Type.Optional(
        Type.Boolean({
          description:
            "Also trust the bundle's signing key when this card is approved. It is part of what the card binds, so the approver decides; ignored for an unsigned bundle",
        }),
      ),
    }),
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
      trustAuthor: Type.Optional(
        Type.Boolean({
          description:
            "Also trust the bundle's signing key when this card is approved. It is part of what the card binds, so the approver decides; ignored for an unsigned bundle",
        }),
      ),
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
    params: Type.Object({
      proposalId: Id,
      approvalId: Id,
      /** Fresh presence for a proposal that also trusts its author: the approved card from a first `approval_required` call. */
      trustApprovalId: Type.Optional(Id),
    }),
    result: Type.Object({ skill: SkillSummarySchema }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: installs a proposal; fails with approval_required without its approved skill_install. A proposal that also trusts its author needs fresh presence once a verifier exists (approval_required with details.approvalId, then retry with trustApprovalId).",
  }),
  "skills.proposeImport": defineMethod({
    params: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 200, description: "File name, for display" }),
      text: Type.String({ minLength: 2, maxLength: 8 * 1024 * 1024 }),
      trustAuthor: Type.Optional(
        Type.Boolean({
          description:
            "Also trust the bundle's signing key when this card is approved. It is part of what the card binds, so the approver decides; ignored for an unsigned bundle",
        }),
      ),
    }),
    result: ProposalResult,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: verifies a .psyche-skill file's signature, hashes and declared permissions, scans it and opens a device-only skill_install approval. invalid_params for a malformed, tampered or mismatched bundle; policy_denied for a revoked signer or a manifest the policy forbids.",
  }),
  "skills.export": defineMethod({
    params: Type.Object({
      name: SkillName,
      authorName: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 64,
          description: "Required when the author key does not exist yet; ignored after",
        }),
      ),
      /** Fresh presence: the approved card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({
      filename: Type.String(),
      bundle: Type.String({ description: "The .psyche-skill file's text" }),
      signer: Type.Object({ keyId: Type.String(), name: Type.String() }),
      createdKey: Type.Boolean(),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: signs a skill of the owner's (workspace, or made by Psyche) with the owner's author key, creating the key on first use (authorName is then required). Only Psyche on the Host itself may call it (forbidden otherwise), and it needs a device-only approval showing the skill's name, tree hash and files (approval_required with details.approvalId, then retry with approvalId; fresh presence once a verifier exists). Every export is audited. The bundle records where the skill came from (workspace or made by Psyche), signed. Refuses a skill someone else wrote.",
  }),
  "skills.authors.list": defineMethod({
    params: EmptyParams,
    result: Type.Object({
      own: Type.Optional(Type.Object({ keyId: Type.String(), name: Type.String() })),
      authors: Type.Array(SkillAuthor),
    }),
    scope: "operator.read",
    description: "Author keys the Gateway has seen on imported bundles, and the owner's own key.",
  }),
  "skills.authors.set": defineMethod({
    params: Type.Object({
      keyId: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
      state: StringEnum(["seen", "trusted", "revoked"]),
      /** Fresh presence for a loosening change: the approved card from a first call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({ author: SkillAuthor }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: trusts, un-trusts or revokes a seen author key. Trust never skips an approval card; a revoked key's bundles are refused and its installed skills stop loading. Trusting a key, or moving one out of revoked, needs fresh presence once a verifier exists (approval_required with details.approvalId, then retry with approvalId); un-trusting and revoking do not.",
  }),
  "skills.authors.rotate": defineMethod({
    params: Type.Object({
      /** Fresh presence: the approved card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({
      from: Type.Object({ keyId: Type.String(), name: Type.String() }),
      to: Type.Object({ keyId: Type.String(), name: Type.String() }),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: replaces the owner's author key with a new one under the same name. The old key signs a statement naming the new key, and bundles the new key signs carry it, so people who trusted the old key see the same author with a new key (signed by the old key); they still have to trust the new key themselves. Only Psyche on the Host itself may call it (forbidden otherwise) and it needs a device-only approval (approval_required with details.approvalId, then retry with approvalId; fresh presence once a verifier exists). The old private key is deleted. Audited. conflict when there is no author key yet.",
  }),
  "skills.authors.createNotice": defineMethod({
    params: Type.Object({
      kind: StringEnum(["key", "bundle"]),
      keyId: Type.Optional(
        Type.String({
          pattern: "^sha256:[0-9a-f]{64}$",
          description:
            "The key to revoke (the current key or one it replaced); the current key by default",
        }),
      ),
      bundleHash: Type.Optional(
        Type.String({
          pattern: "^sha256:[0-9a-f]{64}$",
          description: "For kind bundle: the bundle hash the card showed when it was exported",
        }),
      ),
      reason: Type.String({ minLength: 1, maxLength: 200 }),
      /** Fresh presence: the approved card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({
      filename: Type.String(),
      notice: Type.String({ description: "The .psyche-notice file's text" }),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: signs a revocation notice (this key is revoked, or this bundle is bad) with the owner's author key, for the owner to publish as a file or at a link. Same gates as skills.export: Host shell only, a device-only approval (fresh presence once a verifier exists), audited. conflict when there is no author key; invalid_params for a key that is not the owner's current or earlier key.",
  }),
  "skills.authors.importNotice": defineMethod({
    params: Type.Object({
      name: Type.Optional(
        Type.String({ minLength: 1, maxLength: 200, description: "File name, for display" }),
      ),
      text: Type.Optional(Type.String({ minLength: 2, maxLength: 16 * 1024 })),
      url: Type.Optional(
        Type.String({ minLength: 1, maxLength: 2048, description: "An https link to the notice" }),
      ),
    }),
    result: Type.Object({
      kind: StringEnum(["key", "bundle"]),
      keyId: Type.String(),
      bundleHash: Type.Optional(Type.String()),
      reason: Type.String({ description: "The author's words: data, not instructions" }),
      signer: Type.Object({ keyId: Type.String(), name: Type.String() }),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: verifies a signed revocation notice (a file's text, or an https link under the same rules as a bundle link) and marks the key or bundle revoked. Needs exactly one of text and url. Applied only when it is signed by an author key the owner has seen (or a successor of one, by the rotation chain it carries) and names that key's own lineage or a bundle it signed; invalid_params for a malformed, unsigned or forged notice; policy_denied for an unknown signer or somebody else's key. It can only block: it never trusts anything.",
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
  "skills.drafts.fromRecording": defineMethod({
    params: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 120, description: "The owner's name for it" }),
      steps: Type.Array(BrowserTeachStep, { minItems: 1, maxItems: 200 }),
    }),
    result: Type.Object({ draft: SkillDraft }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: turns the owner's reviewed recording (teach by showing) into a skill draft. Sensitive steps keep no value, typed values are kept only when the owner chose to, and page text is quoted as untrusted. Accept it with skills.drafts.accept for the usual approval card.",
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
