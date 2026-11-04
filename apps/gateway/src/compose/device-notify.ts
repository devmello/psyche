import type { DeviceToast } from "@psyche/notifications";
import type { Surface } from "@psyche/protocol";
import type { Call, HandlerDef, LiveConnection } from "../context.ts";
import type { Gateway } from "../server.ts";
import type { ComposedPart } from "./services.ts";

/**
 * The `device:<deviceId>` notification surface (remote Gateway design §4.2, R2). A remote desktop
 * client that wants OS notifications tells the Host so with `notifications.device.register`, per
 * connection. While that connection is open, the notifier routes whatever it would put on the
 * Host's own OS to `device:<deviceId>` as well, and the adapter publishes it as a
 * `notification.device` event to that device alone. The registration dies with the connection,
 * so nothing is queued for a client that is away (the inbox row and `notifications.list` still
 * hold it). The Host's own screen is notified as before.
 */
export class DeviceNotifications {
  readonly #registered = new Map<string, { deviceId: string; conn: LiveConnection }>();
  #gateway: Gateway | null = null;

  bind(gateway: Gateway | null): void {
    this.#gateway = gateway;
  }

  register(conn: LiveConnection, deviceId: string, enabled: boolean): void {
    if (enabled) this.#registered.set(conn.id, { deviceId, conn });
    else this.#registered.delete(conn.id);
  }

  /** Drops registrations of closed connections; the ids of devices still connected and opted in. */
  #live(): Set<string> {
    const ids = new Set<string>();
    for (const [connId, r] of this.#registered) {
      if (!r.conn.open) this.#registered.delete(connId);
      else ids.add(r.deviceId);
    }
    return ids;
  }

  /** `device:<id>` for each opted-in device that is connected now (the notifier's routing). */
  targets(): Surface[] {
    return [...this.#live()].map((id) => `device:${id}`);
  }

  /** Sends one toast to a device; `false` when it is not connected and opted in. */
  send(deviceId: string, toast: DeviceToast): boolean {
    if (!this.#live().has(deviceId) || this.#gateway === null) return false;
    this.#gateway.bus.publishToDevice(deviceId, "notification.device", toast);
    return true;
  }
}

export function composeDeviceNotifications(notes: DeviceNotifications) {
  return (): ComposedPart => {
    const handlers: Record<string, HandlerDef> = {
      "notifications.device.register": {
        run: (call: Call, params: { enabled: boolean }) => {
          notes.register(call.conn, call.identity.deviceId, params.enabled);
          return { enabled: params.enabled };
        },
      },
    };
    return {
      handlers,
      start(gw) {
        notes.bind(gw);
      },
      stop() {
        notes.bind(null);
      },
    };
  };
}
