import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import { PROTOCOL_VERSION, PsycheError } from "@psyche/protocol";
import { checkCdpCommand, type IsolatedWorldState } from "../bridge/allowlist.ts";
import { acceptBridgeStream, type BridgeClient } from "../bridge/bridge.ts";
import { FrameConnection } from "../bridge/framing.ts";
import { MockBrowser, type MockTab } from "./mock-browser.ts";

/**
 * The desktop side of the bridge, over `MockBrowser`: tab lifecycle, attach, CDP forwarding
 * with the allowlist (spike 01, amendment 4), Take control arbitration (`Input.*` refused with
 * `user_in_control` while the user holds a tab), popups as new tabs with `openerTabId`, and
 * downloads written to a quarantine directory. Tests drive the "human" through `takeControl`.
 */

interface TabState {
  tab: MockTab;
  attached: boolean;
  profile: "logged-in" | "clean";
  control: "agent" | "user" | "paused";
  world: IsolatedWorldState;
  off?: () => void;
}

export interface MockDesktopOptions {
  browser?: MockBrowser;
  quarantineDir: string;
  handshakeSecret?: string;
}

export class MockDesktop {
  readonly browser: MockBrowser;
  readonly #tabs = new Map<string, TabState>();
  readonly #quarantine: string;
  #conn: FrameConnection | undefined;
  #nextDl = 1;
  /** Every CDP method the Gateway sent, in order (allowed or not). */
  readonly sent: string[] = [];
  readonly refused: { method: string; reason: string }[] = [];

  constructor(options: MockDesktopOptions) {
    this.browser = options.browser ?? new MockBrowser();
    this.#quarantine = options.quarantineDir;
    this.browser.hooks = {
      onPopup: (opener, url) => {
        const parent = [...this.#tabs.values()].find((s) => s.tab === opener);
        const tab = this.browser.openTab({ opener });
        const state = this.#adopt(tab, parent?.profile ?? "logged-in");
        this.#event("bridge.tab.created", {
          tab: this.#tabInfo(state),
          openerTabId: opener.id,
          disposition: "new-window",
        });
        // Load after the Gateway had a chance to attach, as Electron's createWindow does.
        setTimeout(() => void tab.navigateTo(url, "GET"), 5);
        return tab;
      },
      onClose: (tab) => {
        const s = this.#tabs.get(tab.id);
        s?.off?.();
        this.#tabs.delete(tab.id);
        this.#event("bridge.tab.closed", { tabId: tab.id });
      },
      onDownload: (tab, dl) => void this.#download(tab, dl),
    };
  }

  /** Connect to a Gateway: returns the authenticated Gateway-side client. */
  async connect(secret = "test-secret"): Promise<BridgeClient> {
    const [gatewaySide, desktopSide] = duplexPair();
    const accepted = acceptBridgeStream(gatewaySide, {
      handshakeSecret: "test-secret",
      gatewayVersion: "test",
    });
    this.#conn = new FrameConnection(desktopSide, {
      onRequest: (method, params) => this.#handle(method, params as Record<string, unknown>),
    });
    await this.#conn.request("bridge.hello", {
      protocolVersion: PROTOCOL_VERSION,
      handshakeSecret: secret,
      desktopVersion: "mock",
    });
    return accepted;
  }

  disconnect(): void {
    this.#conn?.destroy("desktop quit");
  }

  #event(event: string, payload: unknown): void {
    this.#conn?.event(event, payload);
  }

  #adopt(tab: MockTab, profile: "logged-in" | "clean"): TabState {
    const state: TabState = {
      tab,
      attached: false,
      profile,
      control: "agent",
      world: { contexts: new Set(), objects: new Set() },
    };
    this.#tabs.set(tab.id, state);
    return state;
  }

  #tabInfo(s: TabState) {
    return {
      tabId: s.tab.id,
      url: s.tab.url,
      title: s.tab.title,
      partition: s.profile === "clean" ? "agent-clean" : "persist:agent-default",
      profile: s.profile,
      attached: s.attached,
    };
  }

  #state(tabId: unknown): TabState {
    const s = this.#tabs.get(String(tabId));
    if (s === undefined) throw new PsycheError("not_found", `tab ${String(tabId)} not found`);
    return s;
  }

  tab(tabId: string): MockTab {
    return this.#state(tabId).tab;
  }

  /** The "human": keyboard / mouse input or the Take control button. */
  takeControl(tabId: string, via: "keyboard" | "mouse" | "button" = "button"): void {
    const s = this.#state(tabId);
    s.control = "user";
    this.#event("bridge.control.changed", { tabId, state: "user", via });
  }

  release(tabId: string): void {
    const s = this.#state(tabId);
    s.control = "agent";
    this.#event("bridge.control.changed", { tabId, state: "agent", via: "button" });
  }

  async #handle(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "bridge.tabs.list":
        return { tabs: [...this.#tabs.values()].map((s) => this.#tabInfo(s)) };
      case "bridge.tab.open": {
        const tab = this.browser.openTab();
        const s = this.#adopt(tab, p.profile === "clean" ? "clean" : "logged-in");
        this.#event("bridge.tab.created", { tab: this.#tabInfo(s) });
        // The desktop loads the URL only after the Gateway attached (it calls attach next);
        // the driver navigates itself, so this mock opens at about:blank.
        return { tab: this.#tabInfo(s) };
      }
      case "bridge.tab.close": {
        const s = this.#state(p.tabId);
        this.browser.closeTab(s.tab);
        return { ok: true };
      }
      case "bridge.attach": {
        const s = this.#state(p.tabId);
        if (!s.attached) {
          s.attached = true;
          s.off = s.tab.on((m, params) =>
            this.#event("bridge.cdp.event", { tabId: s.tab.id, method: m, params }),
          );
        }
        return { tab: this.#tabInfo(s) };
      }
      case "bridge.detach": {
        const s = this.#state(p.tabId);
        s.off?.();
        s.attached = false;
        return { ok: true };
      }
      case "bridge.cdp.send":
        return { result: await this.#cdp(p) };
      default:
        throw new PsycheError("unknown_method", `mock desktop: ${method}`);
    }
  }

  async #cdp(p: Record<string, unknown>): Promise<unknown> {
    const s = this.#state(p.tabId);
    const method = String(p.method);
    const params = (p.params as Record<string, unknown> | undefined) ?? {};
    this.sent.push(method);
    if (!s.attached) throw new PsycheError("conflict", "tab is not attached");
    const check = checkCdpCommand(method, params, s.world);
    if (!check.ok) {
      this.refused.push({ method, reason: check.reason });
      throw new PsycheError("forbidden", check.reason, {
        details: { reason: "method_not_allowed" },
      });
    }
    if (method.startsWith("Input.") && s.control !== "agent") {
      throw new PsycheError("conflict", "the user is in control of this tab", {
        details: { reason: "user_in_control" },
        retryable: true,
      });
    }
    const result = await s.tab.send(method, params);
    if (method === "Page.createIsolatedWorld") {
      s.world.contexts.add((result as { executionContextId: number }).executionContextId);
    }
    if (method === "DOM.resolveNode") {
      const id = (result as { object: { objectId?: string } }).object.objectId;
      if (id !== undefined) s.world.objects.add(id);
    }
    return result;
  }

  async #download(tab: MockTab, dl: { url: string; filename: string; mime: string; body: string }) {
    const downloadId = `d${this.#nextDl++}`;
    const at = () => new Date().toISOString();
    const base = { tabId: tab.id, downloadId, url: dl.url, filename: dl.filename, mime: dl.mime };
    this.#event("bridge.download", {
      ...base,
      state: "started",
      bytes: null,
      quarantinePath: null,
      at: at(),
    });
    const path = join(this.#quarantine, `${downloadId}-${dl.filename}`);
    await writeFile(path, dl.body);
    this.#event("bridge.download", {
      ...base,
      state: "completed",
      bytes: Buffer.byteLength(dl.body),
      quarantinePath: path,
      at: at(),
    });
  }
}
