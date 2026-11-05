import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { PsycheError } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import type { ComposeServices } from "./services.ts";
import { signGate } from "./skills.ts";

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * `app.uninstall.authorize` (docs/design/updates-and-install-2026.md section 3.5): the gate in
 * front of "Delete my data" in the uninstall sheet. Host desktop shell only, then the owner's
 * device-only card or fresh presence, for this Gateway's own data folder and nothing else: the
 * path is compared with `$PSYCHE_HOME` and put in the card's subject and details, so Touch ID
 * confirms that specific folder. It deletes nothing: the desktop app moves the folder to the
 * Trash itself after this answers.
 */
export function uninstallHandlers(
  services: ComposeServices,
  gate: typeof signGate = signGate,
  home: string = services.home,
): Record<string, HandlerDef> {
  return {
    "app.uninstall.authorize": {
      run: async (call: Call, params: { path: string; approvalId?: string }) => {
        if (call.identity.desktopShell !== true || !call.conn.peer.remoteLoopback) {
          throw new PsycheError("forbidden", "Only Psyche on this computer can uninstall itself");
        }
        const folder = real(home);
        if (real(params.path) !== folder) {
          throw new PsycheError(
            "invalid_params",
            "That is not this Gateway's data folder, so it cannot be moved to the Trash",
          );
        }
        await gate(
          services,
          call,
          {
            method: "app.uninstall.authorize",
            tag: "uninstall-delete-data",
            summary: `Move your Psyche data (${folder}) to the Trash`,
            subject: { uninstall: "delete-data", path: folder },
            treeHash: createHash("sha256").update(`uninstall-delete-data:${folder}`).digest("hex"),
            details: {
              kind: "uninstall_delete_data",
              path: folder,
              note: `Uninstalling Psyche and moving ${folder} (chats, memory, vault, backups) to the Trash. You can still put it back from the Trash.`,
            },
          },
          params.approvalId,
        );
        await services.audit.append({
          kind: "app.uninstall_authorized",
          actor: { type: "user" },
          subject: { scope: "uninstall" },
          data: { path: folder },
        });
        // The pre-update snapshots are inside the data folder, so they travel with it to the
        // Trash and come back with it if the owner changes their mind. Nothing is deleted here.
        return { authorized: true as const };
      },
    },
  };
}
