import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { TaskWorkspace } from "./tasks.ts";

/**
 * VM mode (features L1–L5; architecture §10; security §13; ADR-009; spike 06). The mac helper's
 * `vm.*` node capabilities return and accept these shapes; clients reach them through
 * `nodes.invoke` (the Permission Broker gates writes; read-write shares need an approval), and the
 * Gateway re-broadcasts guest changes as `vm.updated`. Added by S14.
 */

/** Guest lifecycle. `installing`, `provisioning`, `starting`, `running` and `stopping` count
 * against Virtualization.framework's two-active-macOS-guests cap. */
export const VmPhase = StringEnum(
  [
    "created",
    "installing",
    "installed",
    "provisioning",
    "stopped",
    "starting",
    "running",
    "stopping",
    "failed",
  ],
  { $id: "VmPhase" },
);
export type VmPhase = Static<typeof VmPhase>;

/** One host folder shared with the guest. Read-only unless an approval granted write access. */
export const VmShare = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 64 }),
    hostPath: Type.String({ description: "Absolute host folder (symlinks resolved)" }),
    readOnly: Type.Boolean(),
    guestPath: Type.String({ description: "e.g. /Volumes/Psyche Shares/<name>" }),
  },
  { $id: "VmShare" },
);
export type VmShare = Static<typeof VmShare>;

export const VmGuest = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,31}$" }),
    phase: VmPhase,
    provisioned: Type.Boolean({ description: "First (provisioning) boot completed" }),
    cpus: Type.Integer({ minimum: 2 }),
    memoryGB: Type.Integer({ minimum: 4 }),
    diskGB: Type.Integer({ minimum: 40 }),
    guestOS: Nullable(Type.String({ description: "Guest macOS version, e.g. 27.0.1" })),
    username: Type.String(),
    shares: Type.Array(VmShare),
    vsock: Type.Object({
      hostCid: Type.Integer({ description: "2: the host as seen from the guest" }),
      gatewayNodePort: Type.Integer({
        description: "Guest psyche-node → host Gateway node socket",
      }),
    }),
    lastError: Type.Optional(Type.String({ description: "Machine reason of the last failure" })),
  },
  { $id: "VmGuest" },
);
export type VmGuest = Static<typeof VmGuest>;

/** Result of `vm.status`. */
export const VmStatus = Type.Object(
  {
    guests: Type.Array(VmGuest),
    active: Type.Integer({ minimum: 0 }),
    maxActive: Type.Integer({ minimum: 1 }),
    supportsGuestProvisioning: Type.Boolean({
      description: "Unattended setup (macOS 27 host and guest)",
    }),
  },
  { $id: "VmStatus" },
);
export type VmStatus = Static<typeof VmStatus>;

/** `vm.create` params. Without `ipsw`, `download: true` confirms the restore-image download. */
export const VmCreateParams = Type.Object(
  {
    name: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,31}$" })),
    cpus: Type.Optional(Type.Integer({ minimum: 2, maximum: 32 })),
    memoryGB: Type.Optional(Type.Integer({ minimum: 4, maximum: 256 })),
    diskGB: Type.Optional(Type.Integer({ minimum: 40, maximum: 2048 })),
    ipsw: Type.Optional(Type.String({ description: "Absolute path to a local IPSW" })),
    download: Type.Optional(Type.Boolean()),
    username: Type.Optional(Type.String({ maxLength: 32 })),
  },
  { $id: "VmCreateParams" },
);
export type VmCreateParams = Static<typeof VmCreateParams>;

/** `vm.share_add` params. `readOnly` defaults to true; `false` needs an approval. */
export const VmShareAddParams = Type.Object(
  {
    name: Type.Optional(Type.String()),
    share: Type.String({ minLength: 1, maxLength: 64 }),
    path: Type.String({ minLength: 1 }),
    readOnly: Type.Optional(Type.Boolean()),
  },
  { $id: "VmShareAddParams" },
);
export type VmShareAddParams = Static<typeof VmShareAddParams>;

/** Streamed by `vm.create` / `vm.start` (`node.event` data). */
export const VmProgressEvent = Type.Object(
  {
    type: StringEnum(["vm.download", "vm.install", "vm.state"]),
    phase: Type.String({ description: "started | progress | finished, or a VmPhase for vm.state" }),
    fraction: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    version: Type.Optional(Type.String()),
  },
  { $id: "VmProgressEvent" },
);
export type VmProgressEvent = Static<typeof VmProgressEvent>;

export const VmUpdatedPayload = Type.Object(
  { nodeId: Type.String(), guest: VmGuest, at: IsoDateTime },
  { $id: "VmUpdatedPayload" },
);
export type VmUpdatedPayload = Static<typeof VmUpdatedPayload>;

/**
 * The owner's VM-mode settings (`settings.*` keys, admin-only; S11 draws the screen). Values are
 * plain JSON under these keys; absent keys take the defaults in brackets.
 */
export const VM_SETTING_KEYS = {
  /** [false] Run Tasks in the sandbox Mac at all. */
  enabled: "vm.enabled",
  /** [null] The paired psyche-node inside the guest that runs Task commands. */
  guestNodeId: "vm.guestNodeId",
  /** [`sandbox`] Where a Task runs when it names no workspace. */
  defaultWorkspace: "vm.defaultWorkspace",
  /** [`paste-only`] Clipboard between host and guest (security §13). */
  clipboard: "vm.clipboard",
  /** [`host`] Where credentials live: the host vault as a node capability, or a guest vault. */
  credentials: "vm.credentials",
} as const;

export const VmClipboardMode = StringEnum(["paste-only", "bidirectional", "off"], {
  $id: "VmClipboardMode",
});
export type VmClipboardMode = Static<typeof VmClipboardMode>;

export const VmSettings = Type.Object(
  {
    enabled: Type.Boolean(),
    guestNodeId: Nullable(Type.String()),
    defaultWorkspace: TaskWorkspace,
    clipboard: VmClipboardMode,
    credentials: StringEnum(["host", "guest"]),
  },
  { $id: "VmSettings" },
);
export type VmSettings = Static<typeof VmSettings>;
