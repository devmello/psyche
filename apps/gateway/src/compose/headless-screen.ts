import type { SurfaceCall, SurfaceRouter } from "./computer.ts";

/**
 * The Host's private screen as the headless computer-use path sees it (B0 router, B3 rules). The
 * virtual-screen part supplies it (`ComposedVirtualScreen.screen`), so the agent's calls on a
 * headless Host follow the same two rules as everywhere else on that screen (linux design §7.4):
 *
 * - Take over: while the owner has tapped "Take over" in the watch pane, the agent's calls wait
 *   in `agentGate`, bounded, then fail with a retryable `user_in_control`. Only the owner's own
 *   `computerWatch.takeOver` (OwnerProof, `watchAccess`) turns it on or off; the agent cannot.
 * - Task end: the screen's apps are closed. An app that asks "Save changes?" is never discarded:
 *   the Task parks with the unsaved-changes card (`computerWatch.parked`) instead.
 */
export interface HeadlessScreen {
  isTakenOver(): boolean;
  agentGate(signal?: AbortSignal): Promise<void>;
  /** Closes the screen's apps; an app with unsaved changes parks the Task with the card. */
  taskEnded(): Promise<void>;
}

/**
 * Wraps the headless Host's `virtual_screen` router with the take-over gate and the Task-end
 * handling. `screen()` is read on every call; without one (no virtual-screen part) nobody can
 * take over, so nothing waits, and Task end only ends the helper's session.
 *
 * Task end closes the apps only once the last agent session on the screen has ended, so one
 * Task ending never closes another Task's apps, and never while the owner holds control: the
 * apps are the owner's to close then.
 */
export function gateHeadlessRouter(
  router: SurfaceRouter,
  screen: () => HeadlessScreen | undefined,
  log?: (message: string, error: unknown) => void,
): SurfaceRouter {
  const live = new Set<string>();
  return {
    ...router,
    async invoke(call: SurfaceCall) {
      await screen()?.agentGate(call.signal);
      if (call.session !== undefined) live.add(call.session);
      return router.invoke(call);
    },
    async endSession(session: string) {
      live.delete(session);
      await router.endSession?.(session);
      const s = screen();
      if (s === undefined || live.size > 0 || s.isTakenOver()) return;
      await s.taskEnded().catch((err: unknown) => log?.("closing the private screen's apps", err));
    },
  };
}
