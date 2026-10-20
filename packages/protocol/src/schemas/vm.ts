import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTime, Nullable, StringEnum } from "../common.ts";

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
    // M3 (L1): paused in memory; machine state saved to disk (warm start).
    "paused",
    "saved",
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

/** Clipboard between host and guest (security §13): paste-only into the guest by default. */
export const VmClipboardMode = StringEnum(["off", "paste_only", "bidirectional"], {
  $id: "VmClipboardMode",
});
export type VmClipboardMode = Static<typeof VmClipboardMode>;

/** Where credentials live (L5): the host vault as a node capability (default) or a guest vault. */
export const VmVaultPlacement = StringEnum(["host", "guest"], { $id: "VmVaultPlacement" });
export type VmVaultPlacement = Static<typeof VmVaultPlacement>;

/** The guest-side helper on vsock port 7000 (`guest.*` methods). */
export const VmGuestAgentStatus = Type.Object(
  {
    connected: Type.Boolean(),
    version: Type.Optional(Type.String()),
    accessibility: Type.Optional(Type.Boolean()),
    screenRecording: Type.Optional(Type.Boolean()),
    lastSeenAt: Type.Optional(IsoDateTime),
  },
  { $id: "VmGuestAgentStatus" },
);
export type VmGuestAgentStatus = Static<typeof VmGuestAgentStatus>;

/** One file copied into or out of the guest (security §13: write-back is an explicit copy with a receipt). */
export const VmTransfer = Type.Object(
  {
    id: Type.String(),
    direction: StringEnum(["in", "out"]),
    hostPath: Type.String(),
    guestPath: Type.String(),
    bytes: Type.Integer({ minimum: 0 }),
    createdAt: IsoDateTime,
  },
  { $id: "VmTransfer" },
);
export type VmTransfer = Static<typeof VmTransfer>;

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
    // M3 additions (all optional).
    display: Type.Optional(
      Type.Object({ width: Type.Integer(), height: Type.Integer(), visible: Type.Boolean() }),
    ),
    clipboard: Type.Optional(VmClipboardMode),
    vault: Type.Optional(VmVaultPlacement),
    agent: Type.Optional(VmGuestAgentStatus),
    psycheInstalled: Type.Optional(
      Type.Boolean({ description: "Guest Psyche payload installed (L3)" }),
    ),
    permissionsGranted: Type.Optional(
      Type.Boolean({ description: "Accessibility / Screen Recording pre-granted offline (L3)" }),
    ),
    savedState: Type.Optional(
      Type.Boolean({ description: "A machine-state file exists (warm start)" }),
    ),
    transfers: Type.Optional(Type.Array(VmTransfer)),
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
    type: StringEnum([
      "vm.download",
      "vm.install",
      "vm.state",
      "vm.psyche_install",
      "vm.permissions",
    ]),
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

/** `vm.configure` params (guest stopped): resources, display, clipboard, credential placement. */
export const VmConfigureParams = Type.Object(
  {
    name: Type.Optional(Type.String()),
    cpus: Type.Optional(Type.Integer({ minimum: 2, maximum: 32 })),
    memoryGB: Type.Optional(Type.Integer({ minimum: 4, maximum: 256 })),
    displayWidth: Type.Optional(Type.Integer({ minimum: 640, maximum: 3840 })),
    displayHeight: Type.Optional(Type.Integer({ minimum: 480, maximum: 2400 })),
    clipboard: Type.Optional(VmClipboardMode),
    vault: Type.Optional(VmVaultPlacement),
  },
  { $id: "VmConfigureParams" },
);
export type VmConfigureParams = Static<typeof VmConfigureParams>;

/** `vm.copy_in`: a host file or folder into the guest's read-only transfer share. */
export const VmCopyInParams = Type.Object(
  { name: Type.Optional(Type.String()), hostPath: Type.String({ minLength: 1 }) },
  { $id: "VmCopyInParams" },
);
export type VmCopyInParams = Static<typeof VmCopyInParams>;

/** `vm.copy_out`: a guest file to a host folder (inside the granted folders; with a receipt). */
export const VmCopyOutParams = Type.Object(
  {
    name: Type.Optional(Type.String()),
    guestPath: Type.String({ minLength: 1 }),
    hostDir: Type.String({ minLength: 1 }),
  },
  { $id: "VmCopyOutParams" },
);
export type VmCopyOutParams = Static<typeof VmCopyOutParams>;
