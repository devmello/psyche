import type { MethodName, MethodParams, MethodResult } from "@psyche/protocol";
import {
  type ConnectionState,
  type GatewayClient,
  type GatewayEvent,
  GatewayRequestError,
} from "@psyche/ui";
import type { GatewayStatus } from "../client/status.ts";
import type { GatewayPort } from "../shell/platform.ts";

/**
 * The UI kit's `GatewayClient` over the shell's `GatewayPort` (INT-1): one connection, owned by
 * the host (desktop main through the preload bridge, or the web client), shared by the shell and
 * the kit's data layer. Errors that cross the bridge as plain `{code, message}` objects become
 * `GatewayRequestError`s so the kit's hooks show the wire code.
 */

function stateOf(status: GatewayStatus): ConnectionState {
  if (status.phase === "paired") return "open";
  if (status.health === "unreachable") return "offline";
  return "connecting";
}

export function kitClient(port: GatewayPort): GatewayClient {
  let state: ConnectionState = "connecting";
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const setState = (status: GatewayStatus) => {
    const next = stateOf(status);
    if (next === state) return;
    state = next;
    for (const l of stateListeners) l(next);
  };
  void port.getStatus().then(setState, () => undefined);
  port.onStatus(setState);

  return {
    async request<M extends MethodName>(
      method: M,
      params: MethodParams<M>,
      options?: { idempotencyKey?: string },
    ): Promise<MethodResult<M>> {
      try {
        return (await port.call(method, params, options ?? {})) as MethodResult<M>;
      } catch (err) {
        if (err instanceof GatewayRequestError) throw err;
        const e = err as { code?: unknown; message?: unknown };
        throw new GatewayRequestError(
          method,
          typeof e.code === "string" ? e.code : "internal",
          typeof e.message === "string" ? e.message : String(err),
        );
      }
    },
    subscribe(listener) {
      return port.onEvent((raw) => {
        const e = raw as GatewayEvent;
        // The Gateway's `approval.created` carries no per-connection token yet (#50); fetch this
        // device's own token so the kit's card can arm. Without one it stays read-only.
        if (e.event === "approval.created" && e.payload.answerToken === undefined) {
          const approvalId = e.payload.approval.id;
          void (port.call("approvals.get", { approvalId }, {}) as Promise<{ answerToken?: string }>)
            .then(
              (r) => r.answerToken,
              () => undefined,
            )
            .then((answerToken) =>
              listener(
                answerToken === undefined ? e : { ...e, payload: { ...e.payload, answerToken } },
              ),
            );
          return;
        }
        listener(e);
      });
    },
    connectionState: () => state,
    onConnectionState(listener) {
      stateListeners.add(listener);
      // The kit store reads the state when it is built and subscribes later (in an effect); a
      // change in between would be lost, so a new listener hears the current state once.
      if (state !== "connecting") queueMicrotask(() => listener(state));
      return () => stateListeners.delete(listener);
    },
  };
}
