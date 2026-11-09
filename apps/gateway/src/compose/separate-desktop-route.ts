import { type NodeClient, type NodeInvokeResult, PsycheError } from "@psyche/protocol";
import { isRiskyLabel, type SurfaceCall, type SurfaceRouter } from "./computer.ts";

/**
 * Routes `surface: "separate_desktop"` computer-use calls to the separate desktop's guest helper
 * (docs/design/linux-desktop-2026.md §5, §8). The route is the only place the guest is reached
 * from the computer tools:
 *
 * - **Only the guest.** A call goes to `SeparateDesktop.clientFor`, which returns the node bound
 *   to this desktop's container and nothing else. It never falls back to the Host's helper, and
 *   the `direct` and `virtual_screen` surfaces never come here (`computer.ts` picks the router
 *   by surface; this one refuses any other).
 * - **The relaxation lives here only.** File-local risky words (`asks`) skip the card only on
 *   this route, under the rules of `asksInSeparateDesktop`. The guest helper still asks for them
 *   (it enforces the same word list everywhere); when the Gateway has decided the word may pass,
 *   the router repeats the call once with an approval the guest accepts. Nothing else is
 *   relaxed: tiers, sends, quits and a browser's words ask as on the Host.
 * - **One task owns the desktop.** The task is the call's Task (a chat turn without one uses its
 *   run). The first call starts the desktop for that task with no shares and no internet, which
 *   are separate cards; ending the task's last session releases the desktop.
 */

/** The parts of `SeparateDesktop` the route uses (a fake in tests). */
export interface DesktopLike {
  readonly ready: boolean;
  clientFor(surface: "separate_desktop"): NodeClient;
  use(taskId: string): Promise<void>;
  release(taskId: string): Promise<void>;
  asks(taskId: string, text: string | undefined, target: { app?: string }): boolean;
}

const SURFACE = "separate_desktop" as const;

export function separateDesktopRouter(desktop: DesktopLike): SurfaceRouter {
  /** session id -> the task that owns it */
  const sessions = new Map<string, string>();
  let active: string | undefined;

  const taskOf = (call: SurfaceCall): string => call.context.taskId ?? `run:${call.context.runId}`;

  return {
    async invoke(call: SurfaceCall): Promise<NodeInvokeResult> {
      if ((call.surface as string) !== SURFACE) {
        throw new PsycheError("invalid_params", "not a separate desktop call");
      }
      const taskId = taskOf(call);
      if (!desktop.ready) await desktop.use(taskId);
      const client = desktop.clientFor(SURFACE);
      active = taskId;
      if (call.session !== undefined) sessions.set(call.session, taskId);
      const send = (params: Record<string, unknown>, approvalId?: string) =>
        client.invoke(call.capability, params, {
          signal: call.signal,
          timeoutMs: call.timeoutMs,
          ...(approvalId === undefined ? {} : { approvalId }),
        });
      const res = await send(call.params, call.approvalId);
      const d = (res.error?.details ?? {}) as { reason?: unknown; label?: unknown };
      const app = call.params.app;
      if (
        res.ok ||
        call.approvalId !== undefined ||
        res.error?.code !== "approval_required" ||
        d.reason !== "risky_label" ||
        typeof d.label !== "string" ||
        typeof app !== "string" ||
        desktop.asks(taskId, d.label, { app })
      ) {
        return res;
      }
      // The Gateway decided this word may pass here: repeat the call with an approval for this
      // app, once. The guest honours an approval only for the app it names.
      return send(
        { ...call.params, approval: { app, tier: "interact" } },
        `separate-desktop:${taskId}`,
      );
    },

    async endSession(session: string): Promise<void> {
      const taskId = sessions.get(session);
      sessions.delete(session);
      if (taskId === undefined) return;
      if (desktop.ready) {
        await desktop
          .clientFor(SURFACE)
          .invoke("computer.end_session", { session }, { timeoutMs: 5_000 })
          .catch(() => undefined);
      }
      if ([...sessions.values()].includes(taskId)) return;
      if (active === taskId) active = undefined;
      await desktop.release(taskId).catch(() => undefined);
    },

    /** Whether a label asks on this surface (`describeAct`); unknown task: every word asks. */
    asks(text: string | undefined, target: { app?: string }): boolean {
      return active === undefined ? isRiskyLabel(text) : desktop.asks(active, text, target);
    },
  };
}
