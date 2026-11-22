import { PsycheError } from "@psyche/protocol";
import { IPC, rec, str } from "../../lib/ipc.ts";

/**
 * The main window's Allow on a card that needs the owner's password (Linux, linux design §9.4).
 * The renderer sends only the approval id and its own answer token; main forwards them to the
 * Gateway on main's own connection (the desktop shell connection, the only one the Gateway
 * accepts), where polkit is asked and the owner types the password into the system's dialog.
 * Nothing about presence is decided here, and no password passes through this process.
 *
 * Registered in main.ts like the Touch ID channel:
 *
 *   handle(IPC.passwordApprove, (e, arg) => {
 *     approvalWindow(e);
 *     return passwordApprove(requireGateway(), arg);
 *   });
 */
export interface PasswordApproveGateway {
  call(
    method: "approvals.approveWithPassword",
    params: {
      approvalId: string;
      answerToken: string;
    },
  ): Promise<unknown>;
}

export function passwordApprove(gateway: PasswordApproveGateway, arg: unknown): Promise<unknown> {
  if (process.platform !== "linux") {
    throw new PsycheError("unavailable", "Password approvals work on Linux only", {
      details: { reason: "not_linux" },
    });
  }
  const r = rec(IPC.passwordApprove, arg);
  return gateway.call("approvals.approveWithPassword", {
    approvalId: str(IPC.passwordApprove, r.approvalId, "approvalId", 128),
    answerToken: str(IPC.passwordApprove, r.answerToken, "answerToken", 512),
  });
}
