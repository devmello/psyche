import type { SurfaceCall, SurfaceRouter } from "./computer.ts";

/**
 * The Host's private screen as the headless computer-use path sees it (B0 router, B3 rules). The
 * virtual-screen part supplies it (`ComposedVirtualScreen.screen`), so the agent's calls on a
 * headless Host follow the same rules as every other use of that screen (linux design §7.4):
 *
 * - Take over: while the owner has tapped "Take over" in the watch pane, the agent's calls wait
 *   in `agentGate`, bounded, then fail with a retryable `user_in_control`. The tap also aborts
 *   every agent call already in flight on the screen, and the router checks again right before
 *   each send (`assertAgentMayAct`), after its own waits (session check, helper start). Only the
 *   owner's own `computerWatch.takeOver` (OwnerProof, `watchAccess`) turns it on or off.
 * - Parked: while the unsaved-changes card waits for the owner, the agent's calls fail with a
 *   retryable `awaiting_owner`, so the agent can never answer the app's "Save changes?" dialog
 *   ("Don't Save") itself. Only the owner's Look / Discard / Keep open ends it.
 * - Task end: the screen's apps are closed. An app that asks "Save changes?" is never discarded:
 *   the Task parks with the unsaved-changes card (`computerWatch.parked`) instead.
 */
export interface HeadlessScreen {
  isTakenOver(): boolean;
  agentGate(signal?: AbortSignal): Promise<void>;
  /**
   * Runs one agent call on the screen: after `agentGate` and `assertAgentMayAct`, with a signal
   * that aborts (and a result that rejects with `user_in_control`) when the owner takes over.
   */
  agentCall<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Throws unless the agent may act now: not taken over, nothing parked, `signal` live. */
  assertAgentMayAct(signal?: AbortSignal): void;
  /** Closes the screen's apps; an app with unsaved changes parks the Task with the card. */
  taskEnded(): Promise<void>;
}

/**
 * Wraps the headless Host's `virtual_screen` router with the rules above. `screen()` is read on
 * every call; without one (no virtual-screen part) nobody can take over or park, so nothing waits,
 * and Task end only ends the helper's session.
 *
 * Task end closes the apps once the last agent session on the screen has ended (one Task holds
 * the screen at a time, so these are that Task's apps), and never while the owner holds control:
 * the apps are the owner's to close then.
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
      const s = screen();
      if (call.session !== undefined) live.add(call.session);
      if (s === undefined) return router.invoke(call);
      return s.agentCall(call.signal, (signal) => router.invoke({ ...call, signal }));
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
