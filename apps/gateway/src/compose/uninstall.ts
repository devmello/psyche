import { createHash } from "node:crypto";
import { PsycheError } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import type { ComposeServices } from "./services.ts";
import { signGate } from "./skills.ts";

/**
 * `app.uninstall.authorize` (docs/design/updates-and-install-2026.md section 3.5): the gate in
 * front of "Delete my data" in the uninstall sheet. Host desktop shell only, then the owner's
 * device-only card or fresh presence. It deletes nothing: the desktop app moves `~/.psyche` to
 * the Trash itself after this answers, so a remote window or the agent can never reach it.
 */
export function uninstallHandlers(
  services: ComposeServices,
  gate: typeof signGate = signGate,
): Record<string, HandlerDef> {
  return {
    "app.uninstall.authorize": {
      run: async (call: Call, params: { approvalId?: string }) => {
        if (call.identity.desktopShell !== true || !call.conn.peer.remoteLoopback) {
          throw new PsycheError("forbidden", "Only Psyche on this computer can uninstall itself");
        }
        await gate(
          services,
          call,
          {
            method: "app.uninstall.authorize",
            tag: "uninstall-delete-data",
            summary: "Move your Psyche data to the Trash",
            subject: { uninstall: "delete-data" },
            treeHash: createHash("sha256").update("uninstall-delete-data").digest("hex"),
            details: {
              kind: "uninstall_delete_data",
              note: "Uninstalling Psyche and moving the data folder (chats, memory, vault, backups) to the Trash. You can still put it back from the Trash.",
            },
          },
          params.approvalId,
        );
        await services.audit.append({
          kind: "app.uninstall_authorized",
          actor: { type: "user" },
          subject: { scope: "uninstall" },
          data: {},
        });
        return { authorized: true as const };
      },
    },
  };
}
