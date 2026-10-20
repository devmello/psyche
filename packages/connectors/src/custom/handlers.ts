import { ConnectorsMethods, createValidator, PsycheError } from "@psyche/protocol";
import type { TSchema } from "@sinclair/typebox";
import { toWire } from "../framework/handlers.ts";
import type { CustomConnectors } from "./service.ts";

type Name =
  | "connectors.proposeCustom"
  | "connectors.getCustomProposal"
  | "connectors.installCustom"
  | "connectors.removeCustom";

function validated(name: Name, params: unknown): Record<string, unknown> {
  const v = createValidator(ConnectorsMethods[name].params as TSchema);
  const value = params ?? {};
  if (!v.check(value))
    throw new PsycheError("invalid_params", `${name}: ${v.errors(value).join("; ")}`);
  return value as Record<string, unknown>;
}

/** `connectors.*Custom` handlers for the Gateway (protocol methods, M9). */
export function customConnectorHandlers(
  service: CustomConnectors,
): Record<Name, (params: unknown) => Promise<unknown>> {
  return {
    "connectors.proposeCustom": async (p) =>
      service.propose(validated("connectors.proposeCustom", p) as never),
    "connectors.getCustomProposal": async (p) => ({
      proposal: service.getProposal(
        String(validated("connectors.getCustomProposal", p).proposalId),
      ),
    }),
    "connectors.installCustom": async (p) => {
      const v = validated("connectors.installCustom", p);
      return {
        connector: toWire(await service.install(String(v.proposalId), String(v.approvalId))),
      };
    },
    "connectors.removeCustom": async (p) => {
      await service.remove(String(validated("connectors.removeCustom", p).connectorId));
      return { ok: true as const };
    },
  };
}
