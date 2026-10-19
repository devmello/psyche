import {
  type DriverControlState,
  type DriverProfile,
  PsycheError,
  type Unsubscribe,
} from "@psyche/protocol";
import type { BridgeClient } from "../bridge/bridge.ts";
import type { CdpTarget } from "../cdp/page.ts";
import { DriverBase, type DriverDeps, type SessionState, type TabState } from "./base.ts";

/**
 * CDP driver over the desktop bridge (ADR-007, the default). The desktop owns the
 * `WebContentsView`s; this driver opens and attaches tabs through `bridge.*` and drives them
 * with raw CDP via `bridge.cdp.send`. Popups the desktop adopts as tabs
 * (`setWindowOpenHandler`) join the opener's session when the desktop names the opener.
 */
export class CdpBridgeDriver extends DriverBase {
  #bridge: BridgeClient;
  #off: Unsubscribe[] = [];

  constructor(bridge: BridgeClient, deps: DriverDeps) {
    super(deps);
    this.#bridge = bridge;
    this.#off.push(bridge.onEvent((event, payload) => void this.#onBridgeEvent(event, payload)));
    this.#off.push(
      bridge.onClose(() => {
        for (const id of [...this.tabs.keys()]) this.forgetTab(id);
      }),
    );
  }

  async listProfiles(): Promise<DriverProfile[]> {
    return [{ id: "default", name: "Agent profile", kind: "embedded" }];
  }

  protected async createTab(
    s: SessionState,
    url: string | undefined,
  ): Promise<{ id: string; target: CdpTarget; url: string }> {
    // `bridge.tab.open` requires an http(s) URL in protocol v1; the policy already approved
    // `url`. Without one the desktop opens its blank start page (request filed to S11/protocol
    // to make `url` optional and to load only after attach).
    const params: Parameters<BridgeClient["call"]>[1] & Record<string, unknown> = {
      url: url ?? "https://about.invalid/",
      profile: s.session.partition === "clean" ? "clean" : "logged-in",
      background: true,
    };
    if (s.session.taskId !== undefined) params.taskId = s.session.taskId;
    const r = await this.#bridge.call("bridge.tab.open", params as { url: string });
    await this.#bridge.call("bridge.attach", { tabId: r.tab.tabId });
    return { id: r.tab.tabId, target: this.#bridge.target(r.tab.tabId), url: r.tab.url };
  }

  protected async destroyTab(t: TabState): Promise<void> {
    await this.#bridge.call("bridge.tab.close", { tabId: t.tab.id }).catch(() => undefined);
  }

  async #onBridgeEvent(event: string, p: Record<string, unknown>): Promise<void> {
    switch (event) {
      case "bridge.tab.created": {
        // Popups (OAuth windows, target=_blank) arrive here with the opener's id (spike 01
        // amendment, bridge event field `openerTabId`). Tabs we opened ourselves are already
        // known; tabs with an unknown opener are not ours and stay unattached.
        const tab = p.tab as { tabId: string; url: string; openerTabId?: string | null };
        const openerId = tab.openerTabId;
        const opener = typeof openerId === "string" ? this.tabs.get(openerId) : undefined;
        if (opener === undefined || this.tabs.has(tab.tabId)) return;
        try {
          await this.#bridge.call("bridge.attach", { tabId: tab.tabId });
          await this.adoptTab(
            opener.session,
            tab.tabId,
            this.#bridge.target(tab.tabId),
            tab.url,
            opener.tab.id,
          );
        } catch {
          // The popup closed before we attached; nothing to adopt.
        }
        return;
      }
      case "bridge.debugger.detached": {
        // Renderer crash or forced detach: re-attach and re-enable domains; refs go stale.
        const t = this.tabs.get(String(p.tabId));
        if (t === undefined) return;
        try {
          await this.#bridge.call("bridge.attach", { tabId: t.tab.id });
          await t.page.reattached();
        } catch {
          this.forgetTab(t.tab.id);
        }
        return;
      }
      case "bridge.tab.closed":
        this.forgetTab(String(p.tabId));
        return;
      case "bridge.control.changed":
        this.tabControlChanged(String(p.tabId), p.state as DriverControlState);
        return;
      case "bridge.download": {
        const tabId = String(p.tabId);
        if (!this.tabs.has(tabId)) return;
        if (p.state === "completed" && typeof p.quarantinePath === "string") {
          await this.downloadCompleted(tabId, {
            path: p.quarantinePath,
            filename: String(p.filename),
            mime: typeof p.mime === "string" ? p.mime : null,
            url: String(p.url),
          }).catch((err: unknown) =>
            this.downloadFailed(tabId, err instanceof Error ? err.message : String(err)),
          );
        } else if (p.state === "failed" || p.state === "cancelled") {
          this.downloadFailed(tabId, String(p.state));
        }
        return;
      }
      default:
        return;
    }
  }

  /** Re-sync after a reconnect: tabs the desktop still has are listed, not re-adopted. */
  async desktopTabs(): Promise<string[]> {
    if (!this.#bridge.connected) throw new PsycheError("unavailable", "desktop bridge is down");
    const r = await this.#bridge.call("bridge.tabs.list", {});
    return r.tabs.map((t) => t.tabId);
  }

  dispose(): void {
    for (const off of this.#off) off();
  }
}
