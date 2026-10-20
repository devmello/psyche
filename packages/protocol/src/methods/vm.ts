import { Type } from "@sinclair/typebox";
import { Nullable } from "../common.ts";
import { VmRestoreResult, VmSnapshot, VmSnapshotResult } from "../schemas/vm.ts";
import { defineMethod } from "./define.ts";

/**
 * `vm.snapshots.*`: the owner's snapshots and resets of the sandbox Mac (feature L6), served by
 * the Gateway over the mac helper's `vm.snapshot` / `vm.restore` / `vm.reset` /
 * `vm.snapshot_delete` capabilities (S14). Changing the guest is admin-only and audited as a
 * receipt; the Gateway also resets the guest before each `vm` Task when `vm.resetPerTask` is on.
 * Unavailable while VM mode is off or no helper with VM capabilities is connected.
 */
export const VmMethods = {
  "vm.snapshots.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      snapshots: Type.Array(VmSnapshot, { description: "Newest first" }),
      baseSnapshot: Nullable(Type.String()),
    }),
    scope: "operator.read",
    description: "Lists the sandbox Mac's snapshots and its reset point.",
  }),
  "vm.snapshots.create": defineMethod({
    params: Type.Object({
      label: Type.Optional(Type.String({ maxLength: 120 })),
      base: Type.Optional(
        Type.Boolean({
          description: "Make it the reset point (`vm.snapshots.reset` returns here)",
        }),
      ),
    }),
    result: VmSnapshotResult,
    scope: "operator.admin",
    sideEffecting: true,
    description: "Snapshots the stopped or saved sandbox Mac. Side-effecting.",
  }),
  "vm.snapshots.restore": defineMethod({
    params: Type.Object({ snapshot: Type.String({ minLength: 1 }) }),
    result: VmRestoreResult,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Restores the sandbox Mac to a snapshot; its current disk is discarded. Side-effecting.",
  }),
  "vm.snapshots.reset": defineMethod({
    params: Type.Object({}),
    result: VmRestoreResult,
    scope: "operator.admin",
    sideEffecting: true,
    description: 'Resets the sandbox Mac to its base snapshot ("fresh Mac"). Side-effecting.',
  }),
  "vm.snapshots.delete": defineMethod({
    params: Type.Object({ snapshot: Type.String({ minLength: 1 }) }),
    result: Type.Object({ deleted: Type.Literal(true) }),
    scope: "operator.admin",
    sideEffecting: true,
    description: "Deletes a snapshot; deleting the base leaves no reset point. Side-effecting.",
  }),
} as const;
