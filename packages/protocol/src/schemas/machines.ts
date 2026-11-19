import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { INVISIBLE } from "../pairing-link.ts";
import { NodeStatus } from "./identity.ts";
import { ComputerSurface } from "./tools.ts";

/**
 * Machines (docs/design/linux-helper-only-2026.md, section 9): separate computers that run only
 * the helper and that the owner paired so the agent can use their screen, apps, shell and files.
 * Schemas only; the registry, routing and policy are waves H3 to H5.
 */

/**
 * Characters a machine's name may never contain: controls, bidi controls and overrides, zero-width
 * and other default-ignorable format characters, and invisible fillers. The name starts out as what
 * the box reports and appears on every approval card, so it must read as it is. No leading or
 * trailing space, not blank. `machineNameOk` is the same rule for code that checks a string.
 * (Written without `\p{..}` and flags so it is a plain JSON Schema pattern for TypeBox, Swift and
 * Rust.)
 */
const BAD_NAME_CHARS =
  "\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890\\u0891\\u08e2\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufffb\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u2800\\u3000\\ufffc";
export const MACHINE_NAME_PATTERN = `^(?!.*(?:\\udb40[\\udc00-\\udfff]|(?:\\udb41|\\udb42|\\udb43)[\\udc00-\\udfff]|\\ud804[\\udcbd\\udccd]|\\ud834[\\udd73-\\udd7a]|\\ud82f[\\udca0-\\udca3]|\\ud80d[\\udc30-\\udc3f]))[^${BAD_NAME_CHARS}\\s](?:[^${BAD_NAME_CHARS}]*[^${BAD_NAME_CHARS}\\s])?$`;
const MACHINE_NAME_RE = new RegExp(MACHINE_NAME_PATTERN);
const INVISIBLE_ONE = new RegExp(INVISIBLE.source, "u");

/** Whether `name` is an acceptable machine name (1 to 64 characters, no hidden or control text). */
export function machineNameOk(name: unknown): name is string {
  return (
    typeof name === "string" &&
    // A lone surrogate shows as U+FFFD and serde_json refuses its escape; the pattern can't see it.
    name.isWellFormed() &&
    name.length >= 1 &&
    name.length <= 64 &&
    MACHINE_NAME_RE.test(name) &&
    // The pattern is best effort (a plain JSON Schema pattern); this is the full rule that guards
    // `hostName` in a pairing link, so no format or default-ignorable character gets through.
    !INVISIBLE_ONE.test(name)
  );
}

/** A machine's name as the owner sees it ("lab-box"). Every machine name uses this one rule. */
export const MachineName = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: MACHINE_NAME_PATTERN,
  description: "No control, bidi, zero-width or invisible characters; no leading or trailing space",
});

/**
 * Which computer an approval card, receipt or run-trace step is about, when it is not the Host.
 * Absent means the Host. The binding hash of such a card includes `deviceId`, so a card approved
 * for one machine can never be used on the Host or on another machine (wave H4).
 */
export const ComputerMachineRef = Type.Object(
  {
    deviceId: Id,
    name: MachineName,
  },
  { $id: "ComputerMachineRef" },
);
export type ComputerMachineRef = Static<typeof ComputerMachineRef>;

/** How the machine's screen exists: the helper's own private screen, or a real session. */
export const MachineDisplay = StringEnum(["headless", "desktop_session", "container"], {
  $id: "MachineDisplay",
});
export type MachineDisplay = Static<typeof MachineDisplay>;

export const MachineFileRoot = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    mode: StringEnum(["ro", "rw"]),
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
    name: MachineName,
    platform: Type.String({ maxLength: 32, description: "`linux` today" }),
    status: NodeStatus,
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
