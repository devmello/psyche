import { type Static, Type } from "@sinclair/typebox";
import { Id } from "./common.ts";
import { ErrorPayload } from "./errors.ts";
import { DevicePlatform, NodeCapability, type NodeKind } from "./schemas/identity.ts";
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

/**
 * The `deviceFamily` values the Host's own helper declares: the Swift `apps/mac-helper` on macOS
 * and the Rust `apps/win-helper` on Windows. Both speak the same capability names and shapes
 * (minus the Apple-app ones on Windows). The family alone proves nothing: the Gateway makes such
 * a node the Host helper (the `NodeKind` of the same name) only when it connected on the local
 * node transport (the Unix socket, or the named pipe on Windows) with the per-launch handshake
 * secret; anywhere else it is `remote`.
 */
export const HOST_HELPER_FAMILIES = ["mac-helper", "win-helper"] as const;
export type HostHelperFamily = (typeof HOST_HELPER_FAMILIES)[number];

/** Whether a self-declared `deviceFamily` is one of the Host helper families. */
export function isHostHelperFamily(family: string | undefined | null): family is HostHelperFamily {
  return family === "mac-helper" || family === "win-helper";
}

/** Whether a node's kind is the Host's own helper (`mac-helper` or `win-helper`). */
export function isHostHelperKind(kind: NodeKind | string | undefined | null): boolean {
  return kind === "mac-helper" || kind === "win-helper";
}

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
