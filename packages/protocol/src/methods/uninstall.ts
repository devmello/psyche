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
      /** The data folder to be moved to the Trash; must be this Gateway's own `$PSYCHE_HOME`. */
      path: Type.String({ minLength: 1, maxLength: 4096 }),
      /** Fresh presence: the approved card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({ authorized: Type.Literal(true) }, { $id: "UninstallAuthorized" }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting, Psyche desktop shell on the Host only (forbidden for anything else), behind a device-only approval (fresh presence once a verifier exists; approval_required with details.approvalId, then retry with approvalId). Authorizes the desktop app to move the data folder `path` to the Trash (`invalid_params` unless it is this Gateway's own home; the approval card names that exact folder) as part of uninstalling Psyche; it deletes nothing itself and the approval is consumed once. Audited.",
  }),
};
