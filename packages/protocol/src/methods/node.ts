import {
  NodeEventParams,
  NodeInvokeAccepted,
  NodeInvokeParams,
  NodeResultParams,
} from "../node.ts";
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
} as const;
