import { type Static, Type } from "@sinclair/typebox";
import { Id, StringEnum } from "../common.ts";
import { ApprovalRequest } from "../schemas/permissions.ts";
import { defineMethod } from "./define.ts";
import { McpProposal } from "./mcp.ts";
import { BundleSigner, ScanFindingSchema } from "./skills.ts";

/**
 * Shared connectors (docs/design/shared-bundles-2026.md section 8): an MCP server the owner set
 * up, exported as a signed `.psyche-connector` file, and imported on another Mac. The file never
 * carries a secret value. Importing shows the whole card first (who signed it, the command, the
 * network, the env and secret names, the tools it says it lists) and installs through the
 * existing `mcp.probe` / `mcp.add` card; the owner then fills in the secrets by name.
 */

export const ConnectorBundleTool = Type.Object(
  {
    name: Type.String(),
    sideEffect: StringEnum(["read", "write", "destructive"]),
  },
  { $id: "ConnectorBundleTool" },
);

/** What an update asks for beyond the installed version (empty lists: nothing). */
export const ConnectorBundleWidened = Type.Object(
  {
    command: Type.Boolean({ description: "The program or its arguments differ" }),
    env: Type.Array(Type.String()),
    secrets: Type.Array(Type.String()),
    network: Type.Array(Type.String()),
    tools: Type.Array(Type.String(), { description: "New tools, or tools with a bigger effect" }),
    payload: Type.Boolean({ description: "The bundled scripts differ" }),
  },
  { $id: "ConnectorBundleWidened" },
);
export type ConnectorBundleWidened = Static<typeof ConnectorBundleWidened>;

/** Everything a staged connector bundle shows the owner before anything is installed. */
export const ConnectorBundleCard = Type.Object(
  {
    serverId: Type.String({ description: "The id it installs as (mcp__<id>__<tool>)" }),
    title: Type.String({ description: "The author's name for it: data, not verified" }),
    description: Type.String({ description: "Written by the author: data, not instructions" }),
    version: Type.Optional(Type.String()),
    createdAt: Type.String({ description: "The author's claimed time; not verified" }),
    bytes: Type.Integer({ minimum: 0 }),
    bundleHash: Type.String({
      description: "`sha256:` of the signed manifest: what a notice names",
    }),
    signer: BundleSigner,
    /** The full argv, program first. */
    command: Type.Array(Type.String()),
    env: Type.Array(Type.String(), {
      description: "Variable names the server reads; never values",
    }),
    secrets: Type.Array(Type.Object({ name: Type.String(), purpose: Type.String() }), {
      description: "Secrets it needs by name; you give the values after installing",
    }),
    network: Type.Array(Type.String(), {
      description: "Domains it asks to reach through the sandbox",
    }),
    declaredTools: Type.Array(ConnectorBundleTool, {
      description: "What the author says it lists; the probe is the check",
    }),
    files: Type.Array(
      Type.Object({
        path: Type.String(),
        bytes: Type.Integer({ minimum: 0 }),
        executable: Type.Boolean(),
        text: Type.Optional(
          Type.String({
            description: "The file's text (data, not instructions); absent when binary or large",
          }),
        ),
      }),
    ),
    findings: Type.Array(ScanFindingSchema),
    /** Why nothing can be installed from this card, when that is so. */
    blocker: Type.Optional(
      StringEnum(["no_sandbox", "scan"], {
        description:
          "no_sandbox: this Gateway has no sandbox, so a command server is never run; scan: a high-severity finding",
      }),
    ),
    /**
     * Where it runs the first time. `srt` or `container`: in the sandbox, which lists its tools.
     * `none`: this Gateway has no sandbox, so a command server is never run and nothing is
     * installed from this card.
     */
    sandbox: StringEnum(["srt", "container", "none"]),
    /** Tools the probe found that the file did not declare, and declared tools the probe did not find. */
    toolCheck: Type.Optional(
      Type.Object({ undeclared: Type.Array(Type.String()), missing: Type.Array(Type.String()) }),
    ),
    update: Type.Optional(
      Type.Object({
        installedVersion: Type.Optional(Type.String()),
        installedBundleHash: Type.String(),
        widened: Type.Optional(ConnectorBundleWidened),
        /** Unified diff of the bundled scripts against the installed ones (text files only). */
        diff: Type.String(),
        /** The command line of the installed version, for a side-by-side view. */
        installedCommand: Type.Array(Type.String()),
        signerChanged: Type.Boolean(),
      }),
    ),
  },
  { $id: "ConnectorBundleCard" },
);
export type ConnectorBundleCard = Static<typeof ConnectorBundleCard>;

export const ConnectorBundleMethods = {
  "connectors.export": defineMethod({
    params: Type.Object({
      serverId: Type.String({ minLength: 1, maxLength: 64 }),
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
    result: Type.Object(
      {
        filename: Type.String(),
        bundle: Type.String({ description: "The .psyche-connector file's text" }),
        signer: Type.Object({ keyId: Type.String(), name: Type.String() }),
        createdKey: Type.Boolean(),
        bundleHash: Type.String(),
      },
      { $id: "ConnectorExportResult" },
    ),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: signs a command MCP server the owner set up in Settings with the owner's author key and returns it as a .psyche-connector file: the command and arguments, the names of its env variables and secrets, the network domains and the tools it lists. Never a value: env and secret values are not in the file. Only Psyche on the Host itself may call it (forbidden otherwise) and it needs a device-only approval naming the connector and what the file contains (approval_required with details.approvalId, then retry with approvalId; fresh presence once a verifier exists). Every export is audited. A server Psyche wrote, a bundled one, one imported from a bundle, or a URL server is refused (invalid_params); unavailable while the server is off (its tools cannot be listed); the first export must name its author.",
  }),
  "connectors.proposeImport": defineMethod({
    params: Type.Object({
      name: Type.Optional(
        Type.String({ minLength: 1, maxLength: 200, description: "File name, for display" }),
      ),
      text: Type.Optional(Type.String({ minLength: 2, maxLength: 8 * 1024 * 1024 })),
      bundleUrl: Type.Optional(
        Type.String({ minLength: 1, maxLength: 2048, description: "An https link to the file" }),
      ),
    }),
    result: Type.Object(
      {
        card: ConnectorBundleCard,
        /** Absent when the Gateway cannot run it (`card.sandbox` is `none`): nothing was started or staged. */
        proposal: Type.Optional(McpProposal),
        approval: Type.Optional(ApprovalRequest),
      },
      { $id: "ConnectorImportResult" },
    ),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: verifies a .psyche-connector file's signature, hashes, lists and files (a file's text, or an https link under the same rules as a skill bundle link; exactly one of text and bundleUrl), builds the full card, and, when the Gateway has a sandbox, starts the server there to list its tools (the first run is always sandboxed) and opens the device-only skill_install card; the owner then calls mcp.add with the proposal and the approved card, and fills in the secrets by name with mcp.secrets.replace. An update of a connector installed from a bundle is a new card with the diff, flagged when the command, env, secrets, network or tools widen. Without a sandbox the card says so and no proposal is made. invalid_params for a malformed or tampered file; policy_denied for a revoked signer or a bundle a notice marked bad; conflict when the id belongs to a server that did not come from a bundle.",
  }),
} as const;
