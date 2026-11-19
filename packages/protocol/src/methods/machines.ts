import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { MachineInfo, MachineName } from "../schemas/machines.ts";
import { defineMethod } from "./define.ts";

/**
 * `machines.*` (docs/design/linux-helper-only-2026.md, sections 8.2 and 9). Registered by wave H0
 * so clients can be written against the schema; the Gateway answers `not_implemented` until
 * wave H3 (the registry) lands. A machine is added only by pairing (`devices.setupToken.create`
 * with `purpose: "machine"`, or the owner approving a machine pairing request), never by a method
 * here. Removing one is `devices.revoke`.
 */
export const MachinesMethods = {
  "machines.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ machines: Type.Array(MachineInfo) }),
    scope: "operator.read",
    description:
      "Lists the computers the owner paired for Psyche to use (machines), with status, surfaces, the box's own limits and its account. Read-only. Not implemented until the machine registry lands.",
  }),
  "machines.rename": defineMethod({
    params: Type.Object({ id: Id, name: MachineName }),
    result: Type.Object({ machine: MachineInfo }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Renames a machine. Names match case-insensitively and two machines cannot share one (conflict). Side-effecting. Not implemented until the machine registry lands.",
  }),
} as const;
