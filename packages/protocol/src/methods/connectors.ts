import { Type } from "@sinclair/typebox";
import { Id, StringEnum } from "../common.ts";
import {
  CustomConnectorAuth,
  CustomConnectorManifest,
  CustomConnectorProposal,
} from "../schemas/custom-connectors.ts";
import { Connector } from "../schemas/integrations.ts";
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

export const ConnectorsMethods = {
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
