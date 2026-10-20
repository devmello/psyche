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
export const VmClipboardMode = StringEnum(["paste-only", "bidirectional", "off"], {
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

/**
 * L6: a point-in-time copy of a stopped (or saved) guest: disk, auxiliary storage, the helper's
 * state record and, when the guest was saved, its machine state. Taken with APFS clones (instant,
 * copy-on-write; blocks are shared until either side changes). The guest's identity
 * (HardwareModel, MachineIdentifier, MAC address) is never snapshotted: restoring keeps the same Mac.
 */
export const VmSnapshotKind = StringEnum(["base", "manual", "task"], { $id: "VmSnapshotKind" });
export type VmSnapshotKind = Static<typeof VmSnapshotKind>;

/** `apfs-clone` today; `overlay` reserved for DiskImageKit overlays (macOS 27 hosts). */
export const VmSnapshotMethod = StringEnum(["apfs-clone", "overlay"], { $id: "VmSnapshotMethod" });
export type VmSnapshotMethod = Static<typeof VmSnapshotMethod>;

export const VmSnapshot = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
    label: Type.String({ maxLength: 120 }),
    /** `base`: the "fresh Mac" `vm.reset` returns to (at most one per guest); `task`: taken around a Task, pruned automatically. */
    kind: VmSnapshotKind,
    taskId: Type.Optional(Type.String()),
    createdAt: IsoDateTime,
    guestOS: Nullable(Type.String()),
    bytes: Type.Integer({
      minimum: 0,
      description: "Allocated size; clones share unchanged blocks with the guest",
    }),
    savedState: Type.Boolean({ description: "Includes a machine state (restores to saved)" }),
    provisioned: Type.Boolean(),
    psycheInstalled: Type.Boolean(),
    method: VmSnapshotMethod,
  },
  { $id: "VmSnapshot" },
);
export type VmSnapshot = Static<typeof VmSnapshot>;

/** L7: the prebuilt image a guest was created from. */
export const VmGuestImageRef = Type.Object(
  { id: Type.String(), guestOS: Type.String(), createdAt: IsoDateTime },
  { $id: "VmGuestImageRef" },
);
export type VmGuestImageRef = Static<typeof VmGuestImageRef>;

export const VmDiskFormat = StringEnum(["asif", "raw"], { $id: "VmDiskFormat" });
export type VmDiskFormat = Static<typeof VmDiskFormat>;

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
    // L6 additions (optional).
    snapshots: Type.Optional(Type.Array(VmSnapshot, { description: "Newest first" })),
    baseSnapshot: Type.Optional(Type.String({ description: "Id of the `base` snapshot, if any" })),
    // L7 additions (optional).
    image: Type.Optional(VmGuestImageRef),
    passwordRotationPending: Type.Optional(
      Type.Boolean({
        description: "Imported guest still has the image's bootstrap password (rotated at first start)",
      }),
    ),
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
    // L7: create from a prebuilt guest image instead of installing from an IPSW.
    image: Type.Optional(
      Type.String({ description: "Absolute path to a guest image directory or .aar archive" }),
    ),
    imageSha256: Type.Optional(
      Type.String({
        pattern: "^[0-9a-f]{64}$",
        description: "Expected SHA-256 of the image's manifest.json, from the publisher",
      }),
    ),
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
      // L6
      "vm.snapshot",
      "vm.reset",
      // L7
      "vm.import",
      "vm.export",
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

/**
 * `vm.snapshot`: the guest must be stopped, saved or installed. `kind: "base"` makes it the reset
 * point (the previous base becomes `manual`). Snapshots per guest: at most 10 `manual`, and the
 * newest 3 `task` snapshots are kept.
 */
export const VmSnapshotParams = Type.Object(
  {
    name: Type.Optional(Type.String()),
    label: Type.Optional(Type.String({ maxLength: 120 })),
    kind: Type.Optional(VmSnapshotKind),
    taskId: Type.Optional(Type.String()),
  },
  { $id: "VmSnapshotParams" },
);
export type VmSnapshotParams = Static<typeof VmSnapshotParams>;

/** `vm.snapshot` result. */
export const VmSnapshotResult = Type.Object(
  { snapshot: VmSnapshot, guest: VmGuest },
  { $id: "VmSnapshotResult" },
);
export type VmSnapshotResult = Static<typeof VmSnapshotResult>;

/**
 * `vm.restore` (a named snapshot) and `vm.reset` (the base snapshot, "fresh Mac"): the guest must
 * not be active. The current disk is discarded (destructive); the snapshot is kept. A restored
 * guest is `stopped`, or `saved` when the snapshot has a machine state.
 */
export const VmRestoreParams = Type.Object(
  { name: Type.Optional(Type.String()), snapshot: Type.String({ minLength: 1 }) },
  { $id: "VmRestoreParams" },
);
export type VmRestoreParams = Static<typeof VmRestoreParams>;

export const VmResetParams = Type.Object(
  { name: Type.Optional(Type.String()) },
  { $id: "VmResetParams" },
);
export type VmResetParams = Static<typeof VmResetParams>;

/** `vm.restore` / `vm.reset` result. */
export const VmRestoreResult = Type.Object(
  {
    guest: VmGuest,
    snapshot: Type.String(),
    durationMs: Type.Integer({ minimum: 0 }),
  },
  { $id: "VmRestoreResult" },
);
export type VmRestoreResult = Static<typeof VmRestoreResult>;

/** `vm.snapshot_delete`. Deleting the base leaves the guest without a reset point. */
export const VmSnapshotDeleteParams = Type.Object(
  { name: Type.Optional(Type.String()), snapshot: Type.String({ minLength: 1 }) },
  { $id: "VmSnapshotDeleteParams" },
);
export type VmSnapshotDeleteParams = Static<typeof VmSnapshotDeleteParams>;

/** L7: one file of a guest image with its checksum. */
export const VmImageFile = Type.Object(
  {
    name: Type.String({ pattern: "^[A-Za-z0-9._-]{1,64}$" }),
    bytes: Type.Integer({ minimum: 0 }),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  },
  { $id: "VmImageFile" },
);
export type VmImageFile = Static<typeof VmImageFile>;

/**
 * L7: `manifest.json` of a prebuilt guest image: an installed, provisioned guest (Psyche installed
 * and Accessibility / Screen Recording pre-granted) without its machine identity. Importing gives
 * the guest a new MachineIdentifier and MAC and rotates the bootstrap password at first start.
 */
export const VmImageManifest = Type.Object(
  {
    format: Type.Literal("psyche-guest-image"),
    formatVersion: Type.Literal(1),
    id: Type.String({ pattern: "^[a-z0-9][a-z0-9.-]{0,63}$" }),
    guestOS: Type.String(),
    diskFormat: VmDiskFormat,
    diskGB: Type.Integer({ minimum: 40 }),
    username: Type.String(),
    createdAt: IsoDateTime,
    provisioned: Type.Boolean(),
    psycheInstalled: Type.Boolean(),
    permissionsGranted: Type.Boolean(),
    psycheVersion: Type.Optional(Type.String()),
    files: Type.Array(VmImageFile),
  },
  { $id: "VmImageManifest" },
);
export type VmImageManifest = Static<typeof VmImageManifest>;

/** `vm.export_image`: a stopped, provisioned guest to `outDir/<id>/` (manifest, disk, auxiliary storage, hardware model). */
export const VmExportImageParams = Type.Object(
  {
    name: Type.Optional(Type.String()),
    outDir: Type.String({ minLength: 1 }),
    id: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9.-]{0,63}$" })),
  },
  { $id: "VmExportImageParams" },
);
export type VmExportImageParams = Static<typeof VmExportImageParams>;

/** `vm.export_image` result. `manifestSha256` is what a publisher lists next to the image. */
export const VmExportImageResult = Type.Object(
  {
    path: Type.String(),
    manifest: VmImageManifest,
    manifestSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  },
  { $id: "VmExportImageResult" },
);
export type VmExportImageResult = Static<typeof VmExportImageResult>;

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
  /** [false] L6 "fresh Mac per task": the Gateway runs `vm.reset` before each Task in the sandbox. */
  resetPerTask: "vm.resetPerTask",
} as const;

export const VmSettings = Type.Object(
  {
    enabled: Type.Boolean(),
    guestNodeId: Nullable(Type.String()),
    defaultWorkspace: TaskWorkspace,
    clipboard: VmClipboardMode,
    credentials: StringEnum(["host", "guest"]),
    resetPerTask: Type.Optional(Type.Boolean()),
  },
  { $id: "VmSettings" },
);
export type VmSettings = Static<typeof VmSettings>;
