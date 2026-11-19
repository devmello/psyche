import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { ComputerSurface } from "./tools.ts";

/**
 * Machines (docs/design/linux-helper-only-2026.md, section 9): separate computers that run only
 * the helper and that the owner paired so the agent can use their screen, apps, shell and files.
 * Schemas only; the registry, routing and policy are waves H3 to H5.
 */

/**
 * Which computer an approval card, receipt or run-trace step is about, when it is not the Host.
 * Absent means the Host. The binding hash of such a card includes `deviceId`, so a card approved
 * for one machine can never be used on the Host or on another machine (wave H4).
 */
export const ComputerMachineRef = Type.Object(
  {
    deviceId: Id,
    /** The machine's name as the owner sees it ("lab-box"). */
    name: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { $id: "ComputerMachineRef" },
);
export type ComputerMachineRef = Static<typeof ComputerMachineRef>;

export const MachineStatus = StringEnum(["online", "offline", "degraded"], {
  $id: "MachineStatus",
});
export type MachineStatus = Static<typeof MachineStatus>;

/** How the machine's screen exists: the helper's own private screen, or a real session. */
export const MachineDisplay = StringEnum(["headless", "desktop_session", "container"], {
  $id: "MachineDisplay",
});
export type MachineDisplay = Static<typeof MachineDisplay>;

export const MachineFileRoot = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    mode: StringEnum(["ro", "rw"], { $id: "MachineFileMode" }),
  },
  { $id: "MachineFileRoot" },
);
export type MachineFileRoot = Static<typeof MachineFileRoot>;

/**
 * A paired machine as `machines.list` returns it. Everything here is what the Gateway stored or
 * what the box reported through `machine.status`; the box's report is untrusted and for display
 * only. `exec` and `files` are the box's own ceiling (`policy.json`) after the Gateway's
 * narrowing.
 */
export const MachineInfo = Type.Object(
  {
    id: Id,
    deviceId: Id,
    name: Type.String({ minLength: 1, maxLength: 64 }),
    platform: Type.String({ maxLength: 32, description: "`linux` today" }),
    status: MachineStatus,
    display: Nullable(MachineDisplay),
    surfaces: Type.Array(ComputerSurface),
    exec: Type.Object({
      enabled: Type.Boolean(),
      /** Commands run in the contained shell (bubblewrap), not the full account. */
      contained: Type.Boolean(),
    }),
    files: Type.Object({ roots: Type.Array(MachineFileRoot) }),
    account: StringEnum(["own", "dedicated"], { $id: "MachineAccount" }),
    /** Who can change the box's `policy.json`: `root` (deb/rpm) or the owner's account (tarball). */
    policyOwner: StringEnum(["root", "user"], { $id: "MachinePolicyOwner" }),
    passwordlessSudo: Type.Boolean(),
    helperVersion: Nullable(Type.String({ maxLength: 64 })),
    lastSeenAt: Nullable(IsoDateTime),
  },
  { $id: "MachineInfo" },
);
export type MachineInfo = Static<typeof MachineInfo>;
