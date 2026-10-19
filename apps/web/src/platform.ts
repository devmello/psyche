import type { GatewayEvent } from "./client/connection.ts";
import type { GatewayStatus } from "./client/status.ts";
import { createWebGatewayConnection } from "./gateway.ts";
import { browserStorage, type GatewayPort, type ShellPlatform } from "./shell/platform.ts";

/**
 * Web host (feature A8): the shell over a browser WebSocket to `location.origin`. No native panes:
 * the browser pane explains it lives in the desktop app or the server's sidecar, the terminal is
 * absent, and notifications stay in the in-app inbox (Web Push is a follow-up).
 */
export function createWebPlatform(loc: Pick<Location, "origin"> = window.location): ShellPlatform {
  const statusCbs = new Set<(s: GatewayStatus) => void>();
  const eventCbs = new Set<(e: GatewayEvent) => void>();
  const resyncCbs = new Set<() => void>();
  const conn = createWebGatewayConnection(
    {
      onStatus: (s) => {
        for (const cb of statusCbs) cb(s);
      },
      onEvent: (e) => {
        for (const cb of eventCbs) cb(e);
      },
      onResync: () => {
        for (const cb of resyncCbs) cb();
      },
    },
    loc,
  );
  const sub = <T>(set: Set<T>, cb: T) => {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  };
  const gateway: GatewayPort = {
    getStatus: async () => conn.getStatus(),
    onStatus: (cb) => sub(statusCbs, cb),
    onEvent: (cb) => sub(eventCbs, cb),
    onResync: (cb) => sub(resyncCbs, cb),
    call: (method, params, options) => conn.call(method, params, options),
  };
  conn.start();
  return { kind: "web", gateway, storage: browserStorage(), notify: { show: () => undefined } };
}
