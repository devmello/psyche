import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { defineMethod } from "./define.ts";

/**
 * Uninstall (docs/design/updates-and-install-2026.md section 3.5). Deleting `~/.psyche` is the one
 * step of uninstalling that cannot be undone from inside Psyche, so the desktop shell asks the
 * Gateway for the owner's fresh presence first and moves the folder to the Trash only after.
 */
export const UninstallMethods = {
  "app.uninstall.authorize": defineMethod({
    params: Type.Object({
      /** Fresh presence: the approved card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({ authorized: Type.Literal(true) }, { $id: "UninstallAuthorized" }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting, Psyche desktop shell on the Host only (forbidden for anything else), behind a device-only approval (fresh presence once a verifier exists; approval_required with details.approvalId, then retry with approvalId). Authorizes the desktop app to move the data folder to the Trash as part of uninstalling Psyche; it deletes nothing itself and the approval is consumed once. Audited.",
  }),
};
