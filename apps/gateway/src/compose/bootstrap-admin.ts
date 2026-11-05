import { getDevice, listDevices, type PsycheDb, updateDevice } from "@psyche/db";
import { type AuditLog, type MethodResult, PsycheError } from "@psyche/protocol";
import { hostWords } from "@psyche/protocol/host-words";
import { keyFingerprint } from "../auth.ts";
import type { Call, HandlerDef } from "../context.ts";
import { stateSealFor } from "../security/state-seal.ts";

/**
 * First admin device without a terminal (packaged first run). The handshake secret never buys
 * `operator.admin` (S23 review PR-1-A), so a fresh install had to run `psyched devices grant`.
 * `devices.bootstrapAdmin` lets the desktop shell's own connection take admin **only while no
 * admin device exists**: the check and the grant are one immediate SQLite transaction, so two
 * callers cannot both win, and once any admin exists the path is inert (`conflict`). It reaches
 * no further than a same-user process with the bundled CLI already can, and it is audited as
 * `device.bootstrap_admin` (`psyche security audit` flags more than one).
 */

export const BOOTSTRAP_ADMIN_AUDIT_KIND = "device.bootstrap_admin";

export function activeAdminCount(db: PsycheDb): number {
  return listDevices(db).filter(
    (d) => d.pairedAt !== null && d.revokedAt === null && d.scopes.includes("operator.admin"),
  ).length;
}

export function bootstrapAdminHandlers(deps: {
  db: PsycheDb;
  audit: Pick<AuditLog, "append">;
}): Record<string, HandlerDef> {
  return {
    "devices.bootstrapAdmin": {
      async run(call: Call): Promise<MethodResult<"devices.bootstrapAdmin">> {
        const { identity, conn } = call;
        // The desktop shell's proof: loopback, native (no Origin), deviceFamily desktop, and the
        // per-launch handshake secret on this very connection.
        if (
          identity.desktopShell !== true ||
          !conn.peer.remoteLoopback ||
          conn.peer.origin !== null
        ) {
          throw new PsycheError(
            "forbidden",
            `only the Psyche desktop on ${hostWords().thisDevice} can do this`,
          );
        }
        // Untrusted security records: no first admin either (the seal may have been reset to
        // make "no admin exists" true).
        stateSealFor(deps.db)?.ensure();
        if (stateSealFor(deps.db)?.untrusted() != null) {
          throw new PsycheError(
            "presence_required",
            "Psyche's security records failed their check; re-seal them before making an admin",
            { details: { reason: "state_untrusted" } },
          );
        }
        // D8: once a Touch ID key or a passkey could verify (recorded outside the database too),
        // an install with no admin left is a recovery (`psyched devices grant`, 24 hours), not a
        // first run any program holding the handshake secret could claim.
        const seal = stateSealFor(deps.db);
        if (seal?.presenceEverEnrolled() === true || call.ctx.presenceState() !== "off") {
          throw new PsycheError(
            "forbidden",
            "Touch ID or a passkey was set up on this Gateway before; recover admin with `psyched devices grant` on the Mac (it applies after 24 hours)",
            { details: { reason: "presence_enrolled" } },
          );
        }
        const grant = deps.db.sqlite.transaction(() => {
          if (activeAdminCount(deps.db) > 0) {
            throw new PsycheError("conflict", "this Gateway already has an admin device");
          }
          const device = getDevice(deps.db, identity.deviceId);
          if (!device?.pairedAt || device.revokedAt) {
            throw new PsycheError("not_found", "this device is not paired");
          }
          const scopes = [...new Set([...device.scopes, "operator.admin" as const])];
          const updated = updateDevice(deps.db, device.id, { scopes });
          if (!updated) throw new PsycheError("internal", "device update failed");
          return updated;
        });
        const device = grant.immediate();
        await deps.audit.append({
          kind: BOOTSTRAP_ADMIN_AUDIT_KIND,
          actor: { type: "device", deviceId: device.id },
          data: { deviceId: device.id, name: device.name },
        });
        seal?.alerts.add(
          "local_first_admin",
          {
            deviceName: device.name,
            deviceFingerprint: keyFingerprint(device.publicKey),
            scopes: [...device.scopes],
            via: "desktop",
          },
          { severity: "info" },
        );
        call.ctx.bus.bumpStateVersion();
        call.emit("device.updated", { device });
        return { device };
      },
    },
  };
}
