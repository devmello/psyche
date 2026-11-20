import type { PsycheNotifier } from "@psyche/notifications";
import { type AuditLog, PsycheError } from "@psyche/protocol";
import type { Logger } from "../log.ts";
import type { MachineChange } from "../nodes/machines.ts";

/**
 * What the composition root does when a machine is added, renamed or removed (wave H3):
 * the audit entry (`machine.paired`, `machine.renamed`, `machine.revoked`) and, for a new
 * machine, the notice every device shows ("lab-box was added as a computer Psyche can use",
 * `notice.machine.added.*` in packages/ui). The notice goes through the notifier like the other
 * Gateway-authored ones: English fallback text plus message ids for the clients' own language.
 */

export const MACHINE_PAIRED_AUDIT_KIND = "machine.paired";
export const MACHINE_RENAMED_AUDIT_KIND = "machine.renamed";
export const MACHINE_REVOKED_AUDIT_KIND = "machine.revoked";

const AUDIT_KIND: Record<MachineChange["change"], string> = {
  added: MACHINE_PAIRED_AUDIT_KIND,
  renamed: MACHINE_RENAMED_AUDIT_KIND,
  removed: MACHINE_REVOKED_AUDIT_KIND,
};

export function machineChangeHook(deps: {
  audit: Pick<AuditLog, "append">;
  notifier: Pick<PsycheNotifier, "notify">;
  log?: Logger;
}): (change: MachineChange) => void {
  return (change) => {
    void deps.audit
      .append({
        kind: AUDIT_KIND[change.change],
        actor:
          change.byDeviceId == null
            ? { type: "system" }
            : { type: "device", deviceId: change.byDeviceId },
        data: {
          machineId: change.machineId,
          deviceId: change.deviceId,
          name: change.name,
          ...(change.via === undefined ? {} : { via: change.via }),
          ...(change.previousName === undefined ? {} : { previousName: change.previousName }),
        },
      })
      .catch((err: unknown) => {
        deps.log?.log("warn", "audit append for a machine change failed", {
          machineId: change.machineId,
          change: change.change,
          code: PsycheError.from(err).code,
        });
      });
    // A machine that removed itself (`node.unpair`) tells the owner; one the owner removed does not.
    if (change.change === "removed" && change.byDeviceId === change.deviceId) {
      void deps.notifier
        .notify({
          kind: "system",
          title: `${change.name} removed itself`,
          body: "It was a computer Psyche could use. Psyche won't use it again unless you add it again.",
          message: {
            titleKey: "notice.machine.removed.title",
            bodyKey: "notice.machine.removed.body",
            params: { name: change.name },
          },
          route: "/settings/devices",
          dedupeKey: `machine-removed:${change.machineId}`,
        })
        .catch(() => undefined);
      return;
    }
    if (change.change !== "added") return;
    void deps.notifier
      .notify({
        kind: "system",
        title: `${change.name} was added as a computer Psyche can use`,
        body: "Psyche can use its screen, apps, shell and files, and each action there asks you first. If you didn't add it, remove it in Settings → Devices.",
        message: {
          titleKey: "notice.machine.added.title",
          bodyKey: "notice.machine.added.body",
          params: { name: change.name },
        },
        route: "/settings/devices",
        dedupeKey: `machine-added:${change.machineId}`,
      })
      .catch(() => undefined);
  };
}
