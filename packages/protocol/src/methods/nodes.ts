import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { ErrorPayload } from "../errors.ts";
import { InvocationId } from "../node.ts";
import { NodeCapability, NodeInfo } from "../schemas/identity.ts";
import { Receipt } from "../schemas/permissions.ts";
import { defineMethod } from "./define.ts";

/** `nodes.*`: clients reach nodes only through the Gateway (architecture §7). */

export const NodesMethods = {
  "nodes.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ nodes: Type.Array(NodeInfo) }),
    scope: "operator.read",
    description: "Lists paired nodes and their status.",
  }),
  "nodes.capabilities": defineMethod({
    params: Type.Object({ nodeId: Id }),
    result: Type.Object({ nodeId: Id, capabilities: Type.Array(NodeCapability) }),
    scope: "operator.read",
    description: "Returns a node's declared capabilities.",
  }),
  "nodes.invoke": defineMethod({
    params: Type.Object({
      nodeId: Id,
      capability: Type.String({ minLength: 1 }),
      params: Type.Unknown(),
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({
      invocationId: InvocationId,
      ok: Type.Boolean(),
      result: Type.Optional(Type.Unknown()),
      error: Type.Optional(ErrorPayload),
      receipt: Type.Optional(Receipt),
    }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Invokes a node capability through the Permission Broker (may fail with approval_required) and returns its final result. Side-effecting.",
  }),
} as const;
