import { Type } from "@sinclair/typebox";
import { Id, StringEnum } from "../common.ts";
import {
  CustomConnectorAuth,
  CustomConnectorManifest,
  CustomConnectorProposal,
} from "../schemas/custom-connectors.ts";
import {
  Connector,
  ConnectorAuthorization,
  ConnectorCatalogueEntry,
  ConnectorStatus,
} from "../schemas/integrations.ts";
import { ApprovalRequest } from "../schemas/permissions.ts";
import { defineMethod, OkResult } from "./define.ts";

const CustomProposalResult = Type.Object(
  { proposal: CustomConnectorProposal, approval: ApprovalRequest },
  { $id: "CustomConnectorProposalResult" },
);

/**
 * `connectors.*` (data model §8). Custom connectors (M9): a manifest, given directly or derived
 * from an OpenAPI document, is validated, scanned and staged by `connectors.proposeCustom`, which
 * opens a device-only `skill_install` approval with `details.kind: "connector"`;
 * `connectors.installCustom` enables it only with that approval. Never auto-enabled.
 */

const ActionRule = StringEnum(["allow", "ask", "deny"]);

export const ConnectorsMethods = {
  "connectors.catalogue": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ entries: Type.Array(ConnectorCatalogueEntry) }),
    scope: "operator.read",
    description: "Directory of connectors: first-party, remote MCP presets, custom.",
  }),
  "connectors.connect": defineMethod({
    params: Type.Object({
      catalogueId: Type.String({ minLength: 1, maxLength: 128 }),
      scopeMode: StringEnum(["read", "read_act"]),
      label: Type.Optional(Type.String({ maxLength: 200 })),
      /** Non-secret settings only (`clientId`, `tenant`, …); secrets are `{{cred:slug}}` placeholders. */
      config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      /** Re-authorize or change the mode of an existing connector. */
      connectorId: Type.Optional(Id),
    }),
    result: Type.Object({
      connector: Connector,
      /** Present while a sign-in is pending; the connector is `needs_auth` until it completes. */
      authorization: Type.Optional(ConnectorAuthorization),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: starts connecting (or re-authorizing) a connector. OAuth connectors return at once with the consent page in `authorization`; the result arrives as connectors.updated.",
  }),
  "connectors.disconnect": defineMethod({
    params: Type.Object({ connectorId: Id }),
    result: Type.Object({ connector: Connector }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: disconnects, revokes the provider tokens and invalidates pending work.",
  }),
  "connectors.status": defineMethod({
    params: Type.Object({ connectorId: Id }),
    result: Type.Object({
      ok: Type.Boolean(),
      status: ConnectorStatus,
      detail: Type.Optional(Type.String()),
      checkedAt: Type.Integer({ minimum: 0 }),
    }),
    scope: "operator.read",
    description: "Health check of one connector.",
  }),
  "connectors.setMatrix": defineMethod({
    params: Type.Object({ connectorId: Id, matrix: Type.Record(Type.String(), ActionRule) }),
    result: Type.Object({ connector: Connector }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: sets allow / ask / deny per action; destructive and financial actions refuse allow.",
  }),
  "connectors.configure": defineMethod({
    params: Type.Object({
      connectorId: Id,
      /**
       * Non-secret settings merged into the connector's `config` key by key; `null` removes a key.
       * E.g. `shortcutRules` (`{<shortcut id>: "off" | "ask" | "allow"}`) on `apple:shortcuts`, or
       * `vaultPath` and `dailyFolder` on `obsidian`. Secrets stay `{{cred:slug}}` placeholders.
       */
      config: Type.Record(Type.String(), Type.Unknown()),
    }),
    result: Type.Object({ connector: Connector }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: merges non-secret settings into a connector's config (null removes a key) without reconnecting it; announced by connectors.updated.",
  }),
  "connectors.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ connectors: Type.Array(Connector) }),
    scope: "operator.read",
    description: "Lists configured connectors.",
  }),
  "connectors.get": defineMethod({
    params: Type.Object({ connectorId: Id }),
    result: Type.Object({ connector: Connector }),
    scope: "operator.read",
    description: "Returns one connector.",
  }),
  "connectors.proposeCustom": defineMethod({
    params: Type.Object({
      /** A declarative manifest, or an OpenAPI 3 document (JSON or YAML text) to derive one from. */
      manifest: Type.Optional(CustomConnectorManifest),
      openapi: Type.Optional(
        Type.Object({
          document: Type.String({ maxLength: 2_000_000 }),
          id: Type.String({ pattern: "^[a-z][a-z0-9-]{1,40}$" }),
          /** `operationId`s to include; default all (at most 50). */
          operations: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
          auth: Type.Optional(CustomConnectorAuth),
        }),
      ),
      scopeMode: Type.Optional(StringEnum(["read", "read_act"])),
    }),
    result: CustomProposalResult,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: validates and scans a custom connector manifest (or one derived from OpenAPI) and opens a device-only skill_install approval (details.kind connector); invalid_params with details.violations when the manifest is unsafe.",
  }),
  "connectors.getCustomProposal": defineMethod({
    params: Type.Object({ proposalId: Id }),
    result: Type.Object({ proposal: CustomConnectorProposal }),
    scope: "operator.read",
    description:
      "The staged custom connector (full manifest text, findings, diff) for the trust card.",
  }),
  "connectors.installCustom": defineMethod({
    params: Type.Object({ proposalId: Id, approvalId: Id }),
    result: Type.Object({ connector: Connector }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: enables a staged custom connector; approval_required without its approved skill_install.",
  }),
  "connectors.removeCustom": defineMethod({
    params: Type.Object({ connectorId: Id }),
    result: OkResult,
    scope: "operator.admin",
    sideEffecting: true,
    description: "Side-effecting: disconnects and deletes a custom connector and its manifest.",
  }),
} as const;
