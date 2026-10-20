import { type Static, Type } from "@sinclair/typebox";
import { Id, StringEnum } from "../common.ts";
import { ApprovalRequest } from "../schemas/permissions.ts";
import { defineMethod, EmptyParams, OkResult } from "./define.ts";
import { ScanFindingSchema } from "./skills.ts";

/**
 * `plugins.*` (architecture §13 "Plugins"; feature T4; security §11). Code plugins extend the
 * agent harness through declared capabilities only: context sections (always untrusted), a
 * `before_tool_call` check that can only block, observers of finished tool calls and runs, and
 * task checks that can only make the evaluator stricter. Each runs in its own Node process
 * under the permission model (reads its own folder only; no writes, child processes, workers or
 * addons; no secrets in its environment). Installing works like a skill: `plugins.proposeInstall`
 * scans the folder and opens a device-only `skill_install` approval whose details say
 * `kind: "plugin"`; `plugins.install` runs only with that approval. Nothing runs while the admin
 * setting `plugins.enabled` is off (the default). Reads need `operator.read`; every mutation
 * `operator.admin`.
 */

/** Plugin name (`psyche-plugin.json` `name`): lowercase words joined by `-`. */
export const PluginName = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
});

/** What a plugin may do (its manifest's `capabilities`); nothing else is reachable from it. */
export const PluginCapability = StringEnum(
  ["context", "before_tool_call", "after_tool_call", "agent_end", "evaluate"],
  { $id: "PluginCapability" },
);
export type PluginCapability = Static<typeof PluginCapability>;

export const PluginManifestSchema = Type.Object(
  {
    name: PluginName,
    version: Type.String({ minLength: 1, maxLength: 64 }),
    description: Type.String({ maxLength: 1024 }),
    main: Type.String({ minLength: 1, maxLength: 256, description: "ES module inside the folder" }),
    capabilities: Type.Array(PluginCapability, { minItems: 1, maxItems: 5 }),
  },
  { $id: "PluginManifest" },
);
export type PluginManifestSchema = Static<typeof PluginManifestSchema>;

export const PluginStatus = StringEnum(
  ["active", "disabled", "off", "hash_mismatch", "invalid", "failed"],
  {
    $id: "PluginStatus",
    description:
      "`off`: the owner's switch is on but `plugins.enabled` is off; `failed`: its process did not start or stopped answering",
  },
);
export type PluginStatus = Static<typeof PluginStatus>;

export const PluginSummarySchema = Type.Object(
  {
    name: PluginName,
    version: Type.String(),
    description: Type.String(),
    capabilities: Type.Array(PluginCapability),
    source: Type.String({ description: "Where it was installed from (a local folder)" }),
    hash: Type.String({ description: "Tree hash pinned at install" }),
    enabled: Type.Boolean({ description: "The owner's switch for this plugin" }),
    status: PluginStatus,
    installedAt: Type.String(),
    error: Type.Optional(Type.String()),
  },
  { $id: "PluginSummary" },
);
export type PluginSummarySchema = Static<typeof PluginSummarySchema>;

export const PluginProposalSchema = Type.Object(
  {
    id: Id,
    manifest: PluginManifestSchema,
    source: Type.String(),
    hash: Type.String(),
    files: Type.Array(Type.Object({ path: Type.String(), bytes: Type.Integer({ minimum: 0 }) })),
    findings: Type.Array(ScanFindingSchema),
    /** Set when this replaces an installed plugin. */
    fromHash: Type.Optional(Type.String()),
    bindingHash: Type.String(),
  },
  { $id: "PluginProposal" },
);
export type PluginProposalSchema = Static<typeof PluginProposalSchema>;

const ProposalResult = Type.Object({
  proposal: PluginProposalSchema,
  approval: ApprovalRequest,
});

export const PluginsMethods = {
  "plugins.list": defineMethod({
    params: EmptyParams,
    result: Type.Object({
      enabled: Type.Boolean({ description: "The admin setting plugins.enabled" }),
      plugins: Type.Array(PluginSummarySchema),
    }),
    scope: "operator.read",
    description: "Installed plugins with their status, and whether plugins run at all.",
  }),
  "plugins.getProposal": defineMethod({
    params: Type.Object({ proposalId: Id }),
    result: Type.Object({ proposal: PluginProposalSchema }),
    scope: "operator.read",
    description: "A staged install (manifest, files, findings) for its approval card.",
  }),
  "plugins.proposeInstall": defineMethod({
    params: Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096, pattern: "^/" }) }),
    result: ProposalResult,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: reads and scans a local plugin folder and opens a device-only skill_install approval (details.kind plugin).",
  }),
  "plugins.install": defineMethod({
    params: Type.Object({ proposalId: Id, approvalId: Id }),
    result: Type.Object({ plugin: PluginSummarySchema }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: copies an approved proposal into $PSYCHE_HOME/plugins, pinned by hash, disabled until switched on; approval_required without its approved card.",
  }),
  "plugins.setEnabled": defineMethod({
    params: Type.Object({ name: PluginName, enabled: Type.Boolean() }),
    result: Type.Object({ plugin: PluginSummarySchema }),
    scope: "operator.admin",
    sideEffecting: true,
    description: "Side-effecting: sets the owner's switch for one plugin.",
  }),
  "plugins.remove": defineMethod({
    params: Type.Object({ name: PluginName }),
    result: OkResult,
    scope: "operator.admin",
    sideEffecting: true,
    description: "Side-effecting: stops and deletes an installed plugin.",
  }),
};
