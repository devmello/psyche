import { Type } from "@sinclair/typebox";
import {
  NodeEventParams,
  NodeInvokeAccepted,
  NodeInvokeParams,
  NodeResultParams,
} from "../node.ts";
import { Device } from "../schemas/identity.ts";
import { defineMethod, OkResult } from "./define.ts";

/**
 * Node-protocol methods (architecture §7). Unlike every other family these are not called by
 * clients: `node.invoke` flows Gateway → node, `node.event` and `node.result` flow node → Gateway,
 * all on a connection paired with the `node` scope. See `src/node.ts`.
 */
export const NodeMethods = {
  "node.invoke": defineMethod({
    params: NodeInvokeParams,
    result: NodeInvokeAccepted,
    scope: "node",
    description:
      "Gateway → node: run one capability. The node answers accepted, then streams node.event and ends with node.result.",
  }),
  "node.event": defineMethod({
    params: NodeEventParams,
    result: OkResult,
    scope: "node",
    description: "Node → Gateway: streamed progress for an invocation.",
  }),
  "node.result": defineMethod({
    params: NodeResultParams,
    result: OkResult,
    scope: "node",
    description:
      "Node → Gateway: the final outcome of an invocation, with a receipt for side effects.",
  }),
  "node.unpair": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ device: Device }),
    scope: "node",
    description:
      "Machine → Gateway: the machine removes itself (`psyche-helper unpair`). Runs the same cascade as devices.revoke on the caller's own device (the stored machine decision, the node, the audit entry machine.revoked, the owner's notice) and the connection closes right after the reply. Takes no device id, so it can never name another device. Only a connection paired as a machine may call it; any other node gets `forbidden`.",
  }),
} as const;
