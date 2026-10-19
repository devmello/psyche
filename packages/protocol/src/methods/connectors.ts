import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { Connector } from "../schemas/integrations.ts";
import { defineMethod } from "./define.ts";

/** `connectors.*` (data model §8). Read-only in M1. */

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
} as const;
