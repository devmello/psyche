import { type Static, Type } from "@sinclair/typebox";
import { Id } from "./common.ts";
import { ErrorPayload } from "./errors.ts";
import { DevicePlatform, NodeCapability } from "./schemas/identity.ts";
import { Receipt } from "./schemas/permissions.ts";

/**
 * Node protocol (architecture §7; wire spec v1). A node (the mac helper, `psyche-node` in the
 * VM guest, a remote box, a phone) connects like any device with `connect { role: "node",
 * capabilities }`, signs the challenge and is paired with the `node` scope. After that both
 * directions use ordinary `req` / `res` frames on the node's own connection:
 *
 * - Gateway → node: `req node.invoke { invocationId, capability, params, approvalId? }`; the node
 *   answers `res { accepted: true }` as soon as it has queued the work (or an error `res`).
 * - Node → Gateway: zero or more `req node.event { invocationId, data }` for streamed progress,
 *   then exactly one `req node.result { invocationId, ok, result?, error?, receipt? }`.
 *
 * Clients never talk to nodes directly: they call `nodes.invoke`, and the Gateway runs the call
 * through the Permission Broker first. Capabilities declare side-effect classes exactly like
 * tools, so a `computer.click` on a node is treated like any other write. Security settings are
 * never reachable through `node.invoke` (security §10).
 */

export const InvocationId = Type.String({ minLength: 1, maxLength: 128, $id: "InvocationId" });

/** What a node declares at `connect` (and may re-declare later). */
export const CapabilityManifest = Type.Object(
  {
    nodeId: Type.Optional(Id),
    platform: DevicePlatform,
    version: Type.String({ minLength: 1, description: "Node software version" }),
    capabilities: Type.Array(NodeCapability),
  },
  { $id: "CapabilityManifest" },
);
export type CapabilityManifest = Static<typeof CapabilityManifest>;

/** Gateway → node. `approvalId` is set when the Permission Broker required an approval. */
export const NodeInvokeParams = Type.Object(
  {
    invocationId: InvocationId,
    capability: Type.String({ minLength: 1, description: "e.g. computer.click" }),
    params: Type.Unknown(),
    approvalId: Type.Optional(Id),
  },
  { $id: "NodeInvokeParams" },
);
export type NodeInvokeParams = Static<typeof NodeInvokeParams>;

/** Node → Gateway `res` to `node.invoke`: the work is queued; progress follows as events. */
export const NodeInvokeAccepted = Type.Object(
  { accepted: Type.Literal(true) },
  { $id: "NodeInvokeAccepted" },
);
export type NodeInvokeAccepted = Static<typeof NodeInvokeAccepted>;

/** Node → Gateway streamed progress for one invocation. */
export const NodeEventParams = Type.Object(
  { invocationId: InvocationId, data: Type.Unknown() },
  { $id: "NodeEventParams" },
);
export type NodeEventParams = Static<typeof NodeEventParams>;

/** Node → Gateway final outcome. Side-effecting capabilities attach a receipt. */
export const NodeResultParams = Type.Object(
  {
    invocationId: InvocationId,
    ok: Type.Boolean(),
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(ErrorPayload),
    receipt: Type.Optional(Receipt),
  },
  { $id: "NodeResultParams" },
);
export type NodeResultParams = Static<typeof NodeResultParams>;
