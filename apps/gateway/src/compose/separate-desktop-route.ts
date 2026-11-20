import {
  type NodeClient,
  type NodeInvokeResult,
  PsycheError,
  type ToolCallScope,
} from "@psyche/protocol";
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
 *   this route, for the Task that owns the desktop, under the rules of `asksInSeparateDesktop`.
 *   The guest helper still asks for them (it enforces the same word list everywhere); when the
 *   Gateway has decided the word may pass, the router repeats the call once with
 *   `fileLocalLabel`: that exact label, which the guest (and only the guest) honours in its
 *   risky-label check and nowhere else. It is not an approval: tiers, sends, chords, quits and a
 *   browser's words ask as on the Host.
 * - **One task owns the desktop, on every call.** The task is the call's Task (a chat turn
 *   without one uses its run). A call from any other Task, `apps.*` included, is refused
 *   (`separate_desktop_busy`) while the desktop serves one. With no owner, the call claims it
 *   through `use`, which starts the desktop with no shares and no internet (separate cards) and
 *   resets a workspace whose last grants differ. Ending the task's last session releases it.
 */

/** The parts of `SeparateDesktop` the route uses (a fake in tests). */
export interface DesktopLike {
  readonly ready: boolean;
  /** The Task the desktop serves now, if any. */
  owner(): string | undefined;
  clientFor(surface: "separate_desktop"): NodeClient;
  use(taskId: string): Promise<void>;
  release(taskId: string): Promise<void>;
  asks(taskId: string, text: string | undefined, target: { app?: string }): boolean;
}

const SURFACE = "separate_desktop" as const;

const taskKey = (c: { taskId?: string | null; runId: string }): string =>
  c.taskId === undefined || c.taskId === null ? `run:${c.runId}` : c.taskId;

function busy(): PsycheError {
  return new PsycheError(
    "conflict",
    "the separate desktop is busy with another task; try again when it has finished",
    { details: { reason: "separate_desktop_busy" }, retryable: true },
  );
}

export function separateDesktopRouter(desktop: DesktopLike): SurfaceRouter {
  /** session id -> the task that owns it */
  const sessions = new Map<string, string>();

  return {
    async invoke(call: SurfaceCall): Promise<NodeInvokeResult> {
      if ((call.surface as string) !== SURFACE) {
        throw new PsycheError("invalid_params", "not a separate desktop call");
      }
      const taskId = taskKey(call.context);
      // Every call checks the owner: another Task's call never reaches the guest, whatever the
      // tool, and a desktop with no owner is claimed (and reset when the grants differ) first.
      const owner = desktop.owner();
      if (owner !== undefined && owner !== taskId) throw busy();
      if (owner === undefined) await desktop.use(taskId);
      if (desktop.owner() !== taskId) throw busy();
      const client = desktop.clientFor(SURFACE);
      if (call.session !== undefined) sessions.set(call.session, taskId);
      const send = (params: Record<string, unknown>, approvalId?: string) =>
        client.invoke(call.capability, params, {
          signal: call.signal,
          timeoutMs: call.timeoutMs,
          ...(approvalId === undefined ? {} : { approvalId }),
        });
      // Only the retry below names a file-local label; whatever came in with the call is dropped.
      const { fileLocalLabel: _dropped, ...params } = call.params;
      const res = await send(params, call.approvalId);
      const d = (res.error?.details ?? {}) as { reason?: unknown; label?: unknown };
      const app = params.app;
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
      // The Gateway decided this exact word may pass here for this Task: repeat the call once,
      // naming the label. No approval id: nothing else the guest checks is cleared.
      return send({ ...params, fileLocalLabel: d.label });
    },

    async endSession(session: string): Promise<void> {
      const taskId = sessions.get(session);
      sessions.delete(session);
      if (taskId === undefined) return;
      if (desktop.ready && desktop.owner() === taskId) {
        await desktop
          .clientFor(SURFACE)
          .invoke("computer.end_session", { session }, { timeoutMs: 5_000 })
          .catch(() => undefined);
      }
      if ([...sessions.values()].includes(taskId)) return;
      await desktop.release(taskId).catch(() => undefined);
    },

    /**
     * Whether a label asks on this surface for the calling Task (`describeAct`). No caller, or a
     * Task the desktop is not serving: every word asks.
     */
    asks(text: string | undefined, target: { app?: string }, call?: ToolCallScope): boolean {
      if (call === undefined) return isRiskyLabel(text);
      const taskId = taskKey(call);
      if (desktop.owner() !== taskId) return isRiskyLabel(text);
      return desktop.asks(taskId, text, target);
    },
  };
}
