import {
  type DriverEvent,
  type DriverProfile,
  type DriverSession,
  PsycheError,
  type Unsubscribe,
} from "@psyche/protocol";
import type { BrowserDriverEx, DriverEventEx, OpenSessionOptions } from "../types.ts";

/**
 * One `BrowserDriverEx` over several drivers (feature I13): the embedded pane's driver is the
 * primary, and extra drivers (real Chrome, attached only while the owner consented) are added
 * under a key. Each call goes to the driver that owns its session or tab, so the `browser.*`
 * tools, approvals and origin policy work the same whichever browser a tab lives in.
 * Session and tab ids share one owner map: every method's first argument is one of them.
 */
/** Synchronous lookups that must not throw when nothing owns the id (`describeCall`). */
const PEEKS = new Set(["peek", "peekSnapshot", "sessionOf", "tabOrigin", "pendingDialog"]);

export interface RoutingDriver extends BrowserDriverEx {
  /** Open a session on an attached driver (`openSession` uses the primary). */
  openSessionOn(key: string, options: OpenSessionOptions): Promise<DriverSession>;
  attach(key: string, driver: BrowserDriverEx): void;
  /** Forget a driver and every session and tab it owned. */
  detach(key: string): void;
  /** Which driver owns a tab or session: `primary` or the attached key. */
  ownerOf(id: string): string;
}

export function createRoutingDriver(primary: () => BrowserDriverEx): RoutingDriver {
  const drivers = new Map<string, BrowserDriverEx>();
  /** Session or tab id → attached driver key (absent: primary). */
  const owners = new Map<string, string>();
  const offs = new Map<string, Unsubscribe[]>();
  const listeners = new Set<(e: DriverEvent) => void>();
  const exListeners = new Set<(e: DriverEventEx) => void>();

  const driverFor = (id: unknown): BrowserDriverEx => {
    const key = typeof id === "string" ? owners.get(id) : undefined;
    const d = key === undefined ? undefined : drivers.get(key);
    return d ?? primary();
  };

  const wire = (key: string, d: BrowserDriverEx) => {
    const list: Unsubscribe[] = [];
    list.push(
      d.onEventEx((e) => {
        // Tabs (popups included) belong to the driver that reported them.
        if (e.type === "tab_opened") owners.set(e.tabId, key);
        for (const l of [...exListeners]) l(e);
        if (e.type === "tab_closed") owners.delete(e.tabId);
      }),
    );
    list.push(
      d.onEvent((e) => {
        for (const l of [...listeners]) l(e);
      }),
    );
    offs.set(key, list);
  };

  const methods: Partial<RoutingDriver> = {
    attach(key, driver) {
      if (key === "primary" || drivers.has(key)) {
        throw new PsycheError("conflict", `a driver is already attached as ${key}`);
      }
      drivers.set(key, driver);
      wire(key, driver);
    },
    detach(key) {
      for (const off of offs.get(key) ?? []) off();
      offs.delete(key);
      drivers.delete(key);
      for (const [id, owner] of [...owners]) if (owner === key) owners.delete(id);
    },
    ownerOf(id) {
      return owners.get(id) ?? "primary";
    },
    async openSessionOn(key, options) {
      const d = drivers.get(key);
      if (d === undefined) throw new PsycheError("unavailable", `no ${key} browser is attached`);
      const session = await d.openSession(options);
      owners.set(session.id, key);
      return session;
    },
    async listProfiles(): Promise<DriverProfile[]> {
      const all: DriverProfile[] = [];
      try {
        all.push(...(await primary().listProfiles()));
      } catch {
        // no primary (desktop closed)
      }
      for (const d of drivers.values()) all.push(...(await d.listProfiles().catch(() => [])));
      return all;
    },
    openSession(options) {
      return primary().openSession(options);
    },
    async openTab(sessionId, url) {
      const tab = await driverFor(sessionId).openTab(sessionId, url);
      const key = owners.get(sessionId);
      if (key !== undefined) owners.set(tab.id, key);
      return tab;
    },
    async closeSession(sessionId) {
      await driverFor(sessionId).closeSession(sessionId);
      owners.delete(sessionId);
    },
    onEvent(listener) {
      listeners.add(listener);
      let off: Unsubscribe | undefined;
      try {
        off = primary().onEvent(listener);
      } catch {
        // subscribed to attached drivers only
      }
      return () => {
        listeners.delete(listener);
        off?.();
      };
    },
    onEventEx(listener) {
      exListeners.add(listener);
      let off: Unsubscribe | undefined;
      try {
        off = primary().onEventEx(listener);
      } catch {
        // subscribed to attached drivers only
      }
      return () => {
        exListeners.delete(listener);
        off?.();
      };
    },
  };

  return new Proxy(methods as RoutingDriver, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      const own = Reflect.get(target, prop, receiver);
      if (own !== undefined) return own;
      return (...args: unknown[]) => {
        const id = args[0];
        let d: BrowserDriverEx;
        try {
          d = driverFor(id);
        } catch (err) {
          if (PEEKS.has(prop)) return undefined;
          throw err;
        }
        const fn = Reflect.get(d, prop, d) as ((...a: unknown[]) => unknown) | undefined;
        if (typeof fn !== "function") {
          if (PEEKS.has(prop)) return undefined;
          throw new PsycheError("internal", `driver has no method ${prop}`);
        }
        return fn.apply(d, args);
      };
    },
  });
}
