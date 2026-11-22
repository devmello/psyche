import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { ApprovalRequest, ComputerMachineRef } from "@psyche/protocol";
import { t } from "../i18n/core.ts";

/**
 * The machine line on a card (docs/design/linux-helper-only-2026.md §8.3): "On lab-box · Linux ·
 * private screen", or "· command" and "· files". A card for the Host has no `machine` and no
 * line. The name is the owner's own label for the computer, cleaned like any other card text.
 */

/** Where on the computer the action happens, from the card's kind and the surface it names. */
export function machinePlace(
  kind: string,
  details: Readonly<Record<string, unknown>> | undefined,
): string {
  if (kind === "exec_host") return t("machines.place.command");
  if (kind === "folder_access") return t("machines.place.files");
  return details?.surface === "direct" ? t("machines.place.desktop") : t("machines.place.screen");
}

/** The machine's name as a card shows it. */
export function machineLabel(machine: ComputerMachineRef): string {
  return sanitizeDisplay(machine.name, 64);
}

/** The whole line for an approval card, or `null` for the Host. */
export function approvalMachineLine(
  approval: Pick<ApprovalRequest, "kind" | "details"> & { machine?: ComputerMachineRef },
): string | null {
  const machine = approval.machine;
  if (machine === undefined) return null;
  return t("machines.line", {
    // Quoted in the message and isolated here, so a name holding " · " or place words reads as a
    // name and cannot pass for the rest of the line.
    name: `\u2068${machineLabel(machine)}\u2069`,
    place: machinePlace(approval.kind, approval.details as Record<string, unknown>),
  });
}
