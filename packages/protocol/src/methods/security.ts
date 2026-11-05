import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { defineMethod } from "./define.ts";

/**
 * `security.*`: the integrity of the Gateway's security state (docs/design/
 * security-state-integrity-2026.md). Devices, presence keys, grants, approvals, policy and channel
 * access are sealed; a change made outside an authenticated Gateway call is undone and becomes an
 * alert every device shows until an admin acknowledges it. `psyched` commands on the machine that
 * would widen access become recoveries that apply after a delay unless cancelled.
 */

export const SecurityAlertKind = StringEnum(
  [
    /** Rows changed outside Psyche were put back (`details.changes`). */
    "state_changed_outside",
    /** The seal itself failed; widening calls and presence fail closed (`details.reason`). */
    "state_untrusted",
    /** The first start of a version that seals: the state was sealed as it was. */
    "state_first_seal",
    /** Sealed again: after a restored backup (`details.restored`) or a re-seal recovery. */
    "state_resealed",
    /** `psyched devices approve|grant` made the first admin device. */
    "local_first_admin",
    "recovery_requested",
    "recovery_applied",
    "recovery_cancelled",
    "recovery_failed",
  ],
  { $id: "SecurityAlertKind" },
);
export type SecurityAlertKind = Static<typeof SecurityAlertKind>;

export const SecurityRecoveryOp = StringEnum(
  ["devices.approve", "devices.grant", "presence.reset", "seal.reset"],
  { $id: "SecurityRecoveryOp" },
);
export type SecurityRecoveryOp = Static<typeof SecurityRecoveryOp>;

export const SecurityStateChange = Type.Object(
  {
    table: Type.String({ description: "The sealed table: devices, settings, grants, …" }),
    change: StringEnum(["added", "modified", "removed"]),
    name: Type.Optional(Type.String({ description: "The row's label: a device name, a key" })),
  },
  { $id: "SecurityStateChange" },
);

export const SecurityAlert = Type.Object(
  {
    id: Id,
    kind: SecurityAlertKind,
    severity: StringEnum(["warning", "info"]),
    details: Type.Object({
      changes: Type.Optional(Type.Array(SecurityStateChange)),
      /** Changes beyond the ones listed. */
      more: Type.Optional(Type.Integer({ minimum: 0 })),
      reason: Type.Optional(Type.String()),
      recoveryId: Type.Optional(Id),
      op: Type.Optional(SecurityRecoveryOp),
      notBefore: Type.Optional(IsoDateTime),
      deviceName: Type.Optional(Type.String()),
      deviceFingerprint: Type.Optional(
        Type.String({ description: "sha256:<hex> of the device key, shown next to its name" }),
      ),
      scopes: Type.Optional(Type.Array(Type.String())),
      /** How many times this open alert was raised again (one alert, not a wall of them). */
      occurrences: Type.Optional(Type.Integer({ minimum: 1 })),
      /** Who asked: `mac` (a `psyched` command), `desktop` (the app's first-admin bootstrap). */
      via: Type.Optional(StringEnum(["mac", "desktop"])),
      devices: Type.Optional(Type.Integer({ minimum: 0 })),
      admins: Type.Optional(Type.Integer({ minimum: 0 })),
      restored: Type.Optional(Type.Boolean()),
    }),
    createdAt: IsoDateTime,
    acknowledgedAt: Nullable(IsoDateTime),
  },
  { $id: "SecurityAlert" },
);
export type SecurityAlert = Static<typeof SecurityAlert>;

export const SecurityRecovery = Type.Object(
  {
    id: Id,
    op: SecurityRecoveryOp,
    status: StringEnum(["waiting", "applied", "cancelled", "failed"]),
    /** When the Gateway first saw the request, on its own clock. */
    requestedAt: IsoDateTime,
    notBefore: IsoDateTime,
    decidedAt: Nullable(IsoDateTime),
    deviceId: Type.Optional(Id),
    deviceName: Type.Optional(Type.String()),
    deviceFingerprint: Type.Optional(Type.String()),
    scopes: Type.Optional(Type.Array(Type.String())),
    outcome: Nullable(Type.String()),
  },
  { $id: "SecurityRecovery" },
);
export type SecurityRecovery = Static<typeof SecurityRecovery>;

export const SecurityStateStatus = Type.Object(
  {
    status: StringEnum(["sealed", "untrusted"]),
    /** Why the state is untrusted: seal_missing, key_changed, ledger_mismatch, seal_reset, … */
    reason: Nullable(Type.String()),
    alerts: Type.Array(SecurityAlert, {
      description: "Unacknowledged alerts first, newest first, then recent acknowledged ones",
    }),
    recoveries: Type.Array(SecurityRecovery, {
      description: "Waiting recoveries first, then recent ones",
    }),
  },
  { $id: "SecurityStateStatus" },
);
export type SecurityStateStatus = Static<typeof SecurityStateStatus>;

export const SecurityMethods = {
  "security.state.get": defineMethod({
    params: Type.Object({}),
    result: SecurityStateStatus,
    scope: "operator.read",
    description:
      "Whether the security state is sealed, the alerts every device shows, and the local recovery requests that are waiting.",
  }),
  "security.alerts.acknowledge": defineMethod({
    params: Type.Object({
      id: Id,
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({ alert: SecurityAlert }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Marks an alert reviewed. Needs fresh presence once a verifier is enrolled (approval_required, then retry with approvalId). An untrusted state's alerts stay until it is re-sealed. Side-effecting.",
  }),
  "security.recoveries.cancel": defineMethod({
    params: Type.Object({ id: Id }),
    result: Type.Object({ recovery: SecurityRecovery }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Cancels a waiting local recovery request. Narrowing: admin only, no presence. Side-effecting.",
  }),
  "security.recoveries.approve": defineMethod({
    params: Type.Object({
      id: Id,
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({ recovery: SecurityRecovery }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Applies a waiting local recovery request now. Needs fresh presence (approval_required, then retry with approvalId); refused while the state is untrusted and for a re-seal. Side-effecting.",
  }),
} as const;
