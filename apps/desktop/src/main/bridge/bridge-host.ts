import type {
  BridgeEventPayload,
  BridgeMethodParams,
  BridgeProfile,
  BridgeTab,
} from "@psyche/protocol";

/**
 * What the browser-bridge client needs from the tab host. `BrowserHost` implements it over
 * Electron; tests use a fake. Free of Electron types on purpose.
 */

export type Unsubscribe = () => void;

export interface BridgeOpenOptions {
  url: string;
  profile?: BridgeProfile;
  background?: boolean;
  taskId?: string;
  taskTitle?: string;
}

export type BridgeHighlight = NonNullable<BridgeMethodParams<"bridge.tab.status">["highlight"]>;

/** Renderer-facing download notice (same shape as `DownloadNotice` in the web shell). */
export interface HostDownloadNotice {
  downloadId: string;
  tabId: string;
  filename: string;
  state: "started" | "completed" | "failed" | "cancelled";
  quarantined: boolean;
}

export interface HostDownload {
  notice: HostDownloadNotice;
  payload: BridgeEventPayload<"bridge.download">;
}

/** Events the bridge forwards to the Gateway, keyed by host event name. */
export interface BridgeHostEvents {
  tabCreated: BridgeEventPayload<"bridge.tab.created">;
  tabUpdated: BridgeEventPayload<"bridge.tab.updated">;
  tabClosed: BridgeEventPayload<"bridge.tab.closed">;
  controlChanged: BridgeEventPayload<"bridge.control.changed">;
  debuggerDetached: BridgeEventPayload<"bridge.debugger.detached">;
  cdpEvent: BridgeEventPayload<"bridge.cdp.event">;
  download: HostDownload;
}

/** Host event name → bridge event name. */
export const BRIDGE_EVENT_NAMES = {
  tabCreated: "bridge.tab.created",
  tabUpdated: "bridge.tab.updated",
  tabClosed: "bridge.tab.closed",
  controlChanged: "bridge.control.changed",
  debuggerDetached: "bridge.debugger.detached",
  cdpEvent: "bridge.cdp.event",
  download: "bridge.download",
} as const satisfies Record<keyof BridgeHostEvents, string>;

export interface BridgeTabHost {
  list(): BridgeTab[];
  /** Rejects with `PsycheError` (e.g. `invalid_params` for a non-http URL). */
  open(opts: BridgeOpenOptions): Promise<BridgeTab>;
  /** Rejects with `tab_not_found`. */
  close(tabId: string): Promise<void>;
  attach(tabId: string): Promise<BridgeTab>;
  detach(tabId: string): Promise<void>;
  /**
   * Forwards one CDP command. Rejects with `tab_not_found`, `debugger_detached` (retryable),
   * `method_not_allowed`, `user_in_control` (retryable) or the CDP error as `internal`.
   */
  cdpSend(
    tabId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<unknown>;
  setStatus(tabId: string, text: string | null, highlight?: BridgeHighlight): Promise<void>;
  on<E extends keyof BridgeHostEvents>(
    event: E,
    cb: (payload: BridgeHostEvents[E]) => void,
  ): Unsubscribe;
}

/** Minimal typed emitter shared by the host and test fakes. */
export class TypedEmitter<M extends object> {
  private readonly map = new Map<keyof M, Set<(payload: never) => void>>();

  on<E extends keyof M>(event: E, cb: (payload: M[E]) => void): Unsubscribe {
    let set = this.map.get(event);
    if (set === undefined) {
      set = new Set();
      this.map.set(event, set);
    }
    const fn = cb as (payload: never) => void;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  emit<E extends keyof M>(event: E, payload: M[E]): void {
    const set = this.map.get(event);
    if (set === undefined) return;
    for (const cb of [...set]) (cb as (p: M[E]) => void)(payload);
  }

  listenerCount(event: keyof M): number {
    return this.map.get(event)?.size ?? 0;
  }
}
