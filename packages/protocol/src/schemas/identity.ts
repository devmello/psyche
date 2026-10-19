import { type Static, Type } from "@sinclair/typebox";
import { DeviceScope, Id, IsoDateTime, Nullable, SideEffect, StringEnum, TargetKind } from "../common.ts";

/** Data model §1. */
export const DevicePlatform = StringEnum(["macos", "ios", "android", "web", "linux"], { $id: "DevicePlatform" });
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

export const NodeKind = StringEnum(["mac-helper", "vm-guest", "remote", "phone"], { $id: "NodeKind" });
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

export const PairingStatus = StringEnum(["pending", "approved", "denied", "expired"], { $id: "PairingStatus" });
export type PairingStatus = Static<typeof PairingStatus>;

export const PairingRequest = Type.Object(
  {
    id: Id,
    kind: StringEnum(["device", "channel-sender"]),
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
  },
  { $id: "PairingRequest" },
);
export type PairingRequest = Static<typeof PairingRequest>;
