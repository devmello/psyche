import { type Static, Type } from "@sinclair/typebox";
import {
  DeviceScope,
  Id,
  IsoDateTime,
  Nullable,
  SideEffect,
  StringEnum,
  TargetKind,
} from "../common.ts";

/** Data model §1. */
export const DevicePlatform = StringEnum(["macos", "ios", "android", "web", "linux", "windows"], {
  $id: "DevicePlatform",
});
export type DevicePlatform = Static<typeof DevicePlatform>;

export const DeviceRole = StringEnum(["client", "node", "both"], { $id: "DeviceRole" });
export type DeviceRole = Static<typeof DeviceRole>;

/** A paired device. `publicKey` is base64url Ed25519; the token hash never leaves the Gateway. */
export const Device = Type.Object(
  {
    id: Id,
    name: Type.String(),
    platform: DevicePlatform,
    role: DeviceRole,
    publicKey: Type.String({ description: "base64url Ed25519 public key" }),
    scopes: Type.Array(DeviceScope),
    pairedAt: Nullable(IsoDateTime),
    lastSeenAt: Nullable(IsoDateTime),
    revokedAt: Nullable(IsoDateTime),
  },
  { $id: "Device" },
);
export type Device = Static<typeof Device>;

/** One capability a node offers; declares side effects exactly like a tool (architecture §7). */
export const NodeCapability = Type.Object(
  {
    name: Type.String({ description: "e.g. computer.click, notify.show" }),
    description: Type.Optional(Type.String()),
    sideEffect: SideEffect,
    targetKind: Type.Optional(TargetKind),
    inputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    streaming: Type.Optional(Type.Boolean()),
  },
  { $id: "NodeCapability" },
);
export type NodeCapability = Static<typeof NodeCapability>;

/**
 * `mac-helper` and `win-helper` are the Host's own helper (the Gateway's node socket plus the
 * per-launch handshake secret), on macOS and Windows; a node that only claims either family is
 * `remote`. `isHostHelperKind` (node.ts) tests for both.
 */
export const NodeKind = StringEnum(
  ["mac-helper", "vm-guest", "remote", "phone", "win-helper", "host-helper", "guest", "machine"],
  {
    $id: "NodeKind",
    description:
      "win-helper: the Windows helper on the Host (the node socket plus the handshake secret). host-helper: the helper the desktop launched on the Host (macOS mac-helper or Linux linux-helper; stored rows keep mac-helper, which stays a valid alias). guest: the helper inside a separate desktop (container or VM). machine: a separate computer that runs only the helper and that the owner paired so the agent can use its screen, apps, shell and files (docs/design/linux-helper-only-2026.md). SECURITY: the owner's approval is the only way a device becomes a machine; a node can never declare this kind in its own handshake or manifest, and the Gateway sets it from the stored decision (wave H3).",
  },
);
export type NodeKind = Static<typeof NodeKind>;

export const NodeStatus = StringEnum(["online", "offline", "degraded"], { $id: "NodeStatus" });
export type NodeStatus = Static<typeof NodeStatus>;

export const NodeInfo = Type.Object(
  {
    id: Id,
    deviceId: Id,
    kind: NodeKind,
    capabilities: Type.Array(NodeCapability),
    status: NodeStatus,
    lastHeartbeatAt: Nullable(IsoDateTime),
  },
  { $id: "NodeInfo" },
);
export type NodeInfo = Static<typeof NodeInfo>;

export const PairingStatus = StringEnum(["pending", "approved", "denied", "expired"], {
  $id: "PairingStatus",
});
export type PairingStatus = Static<typeof PairingStatus>;

/**
 * What a setup token is for, and what approving a pairing request makes the device. `device` (the
 * default, and what every token was before) pairs a computer's app with the operator scopes the
 * owner chose. `machine` pairs a helper-only Linux computer as a `machine` node: its scopes are
 * always exactly `["node"]`, never chosen by the caller, and its link is `psyche-machine:v1`
 * (`machine-link.ts`). A `device` token never pairs a machine and a `machine` token never pairs a
 * client. The Gateway side is wave H3.
 */
export const SetupTokenPurpose = StringEnum(["device", "machine"], { $id: "SetupTokenPurpose" });
export type SetupTokenPurpose = Static<typeof SetupTokenPurpose>;

export const PairingRequest = Type.Object(
  {
    id: Id,
    kind: StringEnum(["device", "channel-sender"]),
    /**
     * Device requests: what approving this request makes the device. Absent means `device` (an
     * older Gateway never sets it). `machine` is the "wants to let Psyche use its screen, apps,
     * shell and files" card; approving it is what makes the device a `machine` node (H3).
     */
    purpose: Type.Optional(SetupTokenPurpose),
    code: Type.String(),
    deviceId: Nullable(Id),
    channelId: Nullable(Id),
    senderId: Nullable(Type.String()),
    display: Type.String(),
    status: PairingStatus,
    createdAt: IsoDateTime,
    expiresAt: IsoDateTime,
    decidedAt: Nullable(IsoDateTime),
    decidedByDeviceId: Nullable(Id),
    publicKeyFingerprint: Type.Optional(
      Type.String({
        description:
          'Device requests: "sha256:" + hex SHA-256 of the raw Ed25519 public key the owner approves',
      }),
    ),
    transport: Type.Optional(
      StringEnum(["ws", "unix"], { description: "Device requests: how the device connected" }),
    ),
    remoteAddress: Type.Optional(
      Type.String({ description: "Device requests: peer address as the Gateway saw it" }),
    ),
  },
  { $id: "PairingRequest" },
);
export type PairingRequest = Static<typeof PairingRequest>;
