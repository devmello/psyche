import { type BridgeProfile, type BridgeTab, PsycheError } from "@psyche/protocol";
import type { BrowserHostState, BrowserNav, BrowserTabView, Rect } from "@psyche/web/platform";
import {
  BaseWindow,
  type DownloadItem,
  type Session,
  session,
  type WebContents,
  WebContentsView,
  type WebPreferences,
} from "electron";
import {
  type BridgeHighlight,
  type BridgeHostEvents,
  type BridgeOpenOptions,
  type BridgeTabHost,
  TypedEmitter,
  type Unsubscribe,
} from "../bridge/bridge-host.ts";
import {
  CdpPolicy,
  filterCdpEvent,
  isAgentActionMethod,
  isAllowedNavigationUrl,
} from "./cdp-policy.ts";
import { ensureQuarantineDir, quarantinePath, setQuarantineAttribute } from "./downloads.ts";
import {
  cleanPartition,
  DEFAULT_PROFILE_NAME,
  linkProfileDir,
  loggedInPartition,
} from "./partitions.ts";
import { TakeControl } from "./take-control.ts";

/**
 * The embedded agent browser (architecture §5, §8; security §6; spike 01). One `WebContentsView`
 * per tab inside the host `BaseWindow`, each with `webContents.debugger` attached, serving the
 * bridge client (`BridgeTabHost`) and the renderer's browser pane (`BrowserPort` via IPC in main).
 *
 * Every Electron dependency of the browser lives in this file so the rest stays testable in
 * plain Node.
 */

export interface BrowserHostOptions {
  window: BaseWindow;
  psycheHome: string;
  userData: string;
  /** Logged-in profile name (`persist:agent-<name>`). */
  profileName?: string;
  /** Take-control idle release (default 1.5 s). */
  idleMs?: number;
}

export interface BrowserHostEvents extends BridgeHostEvents {
  /** Renderer snapshot, throttled to one per 50 ms. */
  state: BrowserHostState;
  /** The pane is on screen or not (pause-when-unwatched, #272). Sent on change. */
  paneVisible: boolean;
  /** The owner pressed a key or clicked in an agent tab. */
  ownerInput: undefined;
}

interface Tab {
  id: string;
  view: WebContentsView;
  wc: WebContents;
  partition: string;
  profile: BridgeProfile;
  openerTabId: string | null;
  disposition: string | undefined;
  taskId: string | null;
  taskTitle: string | null;
  policy: CdpPolicy;
  control: TakeControl;
  /** Serializes agent Input.* commands. */
  inputChain: Promise<unknown>;
  /** `<sessionId>|<Domain>` enabled by the Gateway through `Domain.enable`. */
  enabled: Set<string>;
  screencast: Set<string>;
  attached: boolean;
  detachRequested: boolean;
  closing: boolean;
  /** Has committed a navigation (the initial about:blank is allowed only before that). */
  navigated: boolean;
  status: string | null;
  highlightTimer: ReturnType<typeof setTimeout> | undefined;
  lastFind: string | null;
  popOut: BaseWindow | undefined;
  subs: (() => void)[];
}

const STATE_THROTTLE_MS = 50;
const HIGHLIGHT_MS = 600;
const DEFAULT_BOUNDS: Rect = { x: 0, y: 0, width: 1280, height: 800 };
/** Action-highlight outline (accent) and fill (transparent). */
const HIGHLIGHT_OUTLINE = { r: 124, g: 92, b: 255, a: 1 };
const HIGHLIGHT_FILL = { r: 0, g: 0, b: 0, a: 0 };
const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];

function domainKey(sessionId: string | undefined, domain: string): string {
  return `${sessionId ?? ""}|${domain}`;
}

function headerValue(headers: Record<string, string[]> | undefined, name: string): string {
  if (headers === undefined) return "";
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v.join(",");
  return "";
}

function tabPrefs(partition: string): WebPreferences {
  return {
    partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    webSecurity: true,
    // Agent tabs are usually off screen; throttling stalls input and screencast (gotcha 1).
    backgroundThrottling: false,
    spellcheck: false,
    safeDialogs: true,
  };
}

export class BrowserHost implements BridgeTabHost {
  private readonly win: BaseWindow;
  private readonly home: string;
  private readonly userData: string;
  private readonly profileName: string;
  private readonly idleMs: number | undefined;
  private readonly emitter = new TypedEmitter<BrowserHostEvents>();
  private readonly tabs = new Map<string, Tab>();
  private readonly byWebContents = new Map<number, Tab>();
  private readonly sessions = new WeakSet<Session>();
  private readonly cleanByTask = new Map<string, string>();
  private readonly cleanPartitions = new Set<string>();
  private nextTab = 1;
  private nextDownload = 1;
  private active: string | null = null;
  private viewport: Rect | null = null;
  private lastBounds: Rect = DEFAULT_BOUNDS;
  private bridgeConnected = false;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(opts: BrowserHostOptions) {
    this.win = opts.window;
    this.home = opts.psycheHome;
    this.userData = opts.userData;
    this.profileName = opts.profileName ?? DEFAULT_PROFILE_NAME;
    this.idleMs = opts.idleMs;
  }

  // ── events ──────────────────────────────────────────────────────────────────────────────

  on<E extends keyof BrowserHostEvents>(
    event: E,
    cb: (payload: BrowserHostEvents[E]) => void,
  ): Unsubscribe {
    return this.emitter.on(event, cb);
  }

  /** Wire to `BridgeClient.onConnectedChange`. */
  setBridgeConnected(on: boolean): void {
    if (this.bridgeConnected === on) return;
    this.bridgeConnected = on;
    this.scheduleState();
  }

  getState(): BrowserHostState {
    return {
      tabs: [...this.tabs.values()].map((t) => this.view(t)),
      activeTabId: this.active,
      bridgeConnected: this.bridgeConnected,
    };
  }

  private view(t: Tab): BrowserTabView {
    const alive = !t.wc.isDestroyed();
    return {
      tabId: t.id,
      url: alive ? t.wc.getURL() : "",
      title: alive ? t.wc.getTitle() : "",
      profile: t.profile,
      controller: t.control.state,
      loading: alive && t.wc.isLoading(),
      canGoBack: alive && t.wc.navigationHistory.canGoBack(),
      canGoForward: alive && t.wc.navigationHistory.canGoForward(),
      zoomFactor: alive ? t.wc.getZoomFactor() : 1,
      status: t.status,
      taskId: t.taskId,
      taskTitle: t.taskTitle,
      openerTabId: t.openerTabId,
    };
  }

  private bridgeTab(t: Tab): BridgeTab {
    const alive = !t.wc.isDestroyed();
    const tab: BridgeTab = {
      tabId: t.id,
      url: alive ? t.wc.getURL() : "",
      title: alive ? t.wc.getTitle() : "",
      partition: t.partition,
      profile: t.profile,
      attached: t.attached,
      openerTabId: t.openerTabId,
      taskId: t.taskId,
    };
    if (t.disposition !== undefined) tab.disposition = t.disposition;
    return tab;
  }

  private scheduleState(): void {
    if (this.stateTimer !== undefined || this.disposed) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.emitter.emit("state", this.getState());
    }, STATE_THROTTLE_MS);
  }

  private updated(t: Tab): void {
    if (t.closing) return;
    this.emitter.emit("tabUpdated", { tab: this.bridgeTab(t) });
    this.scheduleState();
  }

  // ── sessions ────────────────────────────────────────────────────────────────────────────

  private partitionFor(profile: BridgeProfile, taskId: string | undefined): string {
    if (profile === "logged-in") return loggedInPartition(this.profileName);
    if (taskId !== undefined) {
      const existing = this.cleanByTask.get(taskId);
      if (existing !== undefined) return existing;
    }
    const p = cleanPartition();
    if (taskId !== undefined) this.cleanByTask.set(taskId, p);
    this.cleanPartitions.add(p);
    return p;
  }

  /** Session-level policy, once per partition: deny permissions, quarantine, PDF interception. */
  private prepareSession(partition: string): void {
    if (partition === loggedInPartition(this.profileName))
      linkProfileDir(this.userData, this.home, this.profileName);
    const ses = session.fromPartition(partition);
    if (this.sessions.has(ses)) return;
    this.sessions.add(ses);
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on("will-download", (event, item, wc) => this.onWillDownload(event, item, wc));
    // Inline PDFs open in Chromium's viewer without `will-download` (gotcha 9, amendment 5):
    // cancel main-frame PDF responses and re-fetch them as a download so they land in
    // quarantine. Edge cases: the re-fetch is a plain GET (a PDF answering a POST, or behind a
    // single-use URL, may fail or differ); the cancelled navigation leaves the tab on the
    // previous page (about:blank for a fresh tab); PDFs in iframes/objects are not intercepted
    // and still render in the viewer; `Content-Disposition: attachment` is left to will-download.
    ses.webRequest.onHeadersReceived(
      { urls: ["http://*/*", "https://*/*"], types: ["mainFrame"] },
      (details, cb) => {
        const type = headerValue(details.responseHeaders, "content-type").toLowerCase();
        const disposition = headerValue(details.responseHeaders, "content-disposition");
        const isPdf = type.split(";")[0]?.trim() === "application/pdf";
        if (!isPdf || /^\s*attachment/i.test(disposition) || details.statusCode >= 300) {
          cb({});
          return;
        }
        cb({ cancel: true });
        const wc = details.webContents;
        if (wc !== undefined && !wc.isDestroyed() && this.byWebContents.has(wc.id))
          wc.downloadURL(details.url);
      },
    );
  }

  // ── tabs ────────────────────────────────────────────────────────────────────────────────

  list(): BridgeTab[] {
    return [...this.tabs.values()].map((t) => this.bridgeTab(t));
  }

  private need(tabId: string): Tab {
    const t = this.tabs.get(tabId);
    if (t === undefined || t.closing) throw new PsycheError("tab_not_found", `no tab ${tabId}`);
    return t;
  }

  async open(opts: BridgeOpenOptions): Promise<BridgeTab> {
    if (!isAllowedNavigationUrl(opts.url))
      throw new PsycheError("invalid_params", "only http and https URLs open in agent tabs");
    const profile = opts.profile ?? "logged-in";
    const t = this.createTab({
      partition: this.partitionFor(profile, opts.taskId),
      profile,
      openerTabId: null,
      disposition: undefined,
      taskId: opts.taskId ?? null,
      taskTitle: opts.taskTitle ?? null,
      background: opts.background ?? false,
    });
    void t.wc.loadURL(opts.url).catch(() => {
      // Load failures surface as navigation state; the Gateway reads them over CDP.
    });
    return this.bridgeTab(t);
  }

  /** Renderer: user-opened tab (no task). Returns the tab id. */
  async openTab(url: string, profile: BridgeProfile = "logged-in"): Promise<string> {
    return (await this.open({ url, profile })).tabId;
  }

  async close(tabId: string): Promise<void> {
    const t = this.need(tabId);
    t.closing = true;
    if (t.wc.isDestroyed()) {
      this.removeTab(t);
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.removeTab(t);
        resolve();
      }, 2_000);
      t.wc.once("destroyed", () => {
        clearTimeout(timer);
        resolve();
      });
      t.wc.close();
    });
  }

  closeTab(tabId: string): Promise<void> {
    return this.close(tabId);
  }

  async activateTab(tabId: string): Promise<void> {
    this.need(tabId);
    this.active = tabId;
    this.layout();
    this.scheduleState();
  }

  setTask(tabId: string, taskId: string | null, taskTitle: string | null): void {
    const t = this.need(tabId);
    t.taskId = taskId;
    t.taskTitle = taskTitle;
    this.updated(t);
  }

  private createTab(o: {
    partition: string;
    profile: BridgeProfile;
    openerTabId: string | null;
    disposition: string | undefined;
    taskId: string | null;
    taskTitle: string | null;
    background: boolean;
    webContents?: WebContents;
  }): Tab {
    this.prepareSession(o.partition);
    const view =
      o.webContents === undefined
        ? new WebContentsView({ webPreferences: tabPrefs(o.partition) })
        : new WebContentsView({ webContents: o.webContents });
    const wc = view.webContents;
    const id = `tab_${this.nextTab++}`;
    const t: Tab = {
      id,
      view,
      wc,
      partition: o.partition,
      profile: o.profile,
      openerTabId: o.openerTabId,
      disposition: o.disposition,
      taskId: o.taskId,
      taskTitle: o.taskTitle,
      policy: new CdpPolicy(),
      inputChain: Promise.resolve(),
      control: new TakeControl(this.idleMs === undefined ? {} : { idleMs: this.idleMs }),
      enabled: new Set(),
      screencast: new Set(),
      attached: false,
      detachRequested: false,
      closing: false,
      navigated: false,
      status: null,
      highlightTimer: undefined,
      lastFind: null,
      popOut: undefined,
      subs: [],
    };
    this.tabs.set(id, t);
    this.byWebContents.set(wc.id, t);
    this.wireTab(t);
    this.attachDebugger(t);
    view.setBounds(this.lastBounds);
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    if (!o.background || this.active === null) this.active = id;
    this.layout();
    this.emitter.emit("tabCreated", { tab: this.bridgeTab(t) });
    this.scheduleState();
    return t;
  }

  private removeTab(t: Tab): void {
    if (!this.tabs.has(t.id)) return;
    t.closing = true;
    this.tabs.delete(t.id);
    this.byWebContents.delete(t.wc.id);
    clearTimeout(t.highlightTimer);
    t.control.dispose();
    for (const u of t.subs.splice(0)) u();
    try {
      if (t.popOut !== undefined && !t.popOut.isDestroyed()) {
        t.popOut.contentView.removeChildView(t.view);
        t.popOut.destroy();
      } else if (!this.win.isDestroyed()) this.win.contentView.removeChildView(t.view);
    } catch {
      // The window is already gone.
    }
    if (this.active === t.id) this.active = [...this.tabs.keys()].at(-1) ?? null;
    this.layout();
    this.emitter.emit("tabClosed", { tabId: t.id });
    this.scheduleState();
  }

  private allowNavigation(t: Tab, url: string): boolean {
    if (isAllowedNavigationUrl(url)) return true;
    return !t.navigated && url === "about:blank";
  }

  private wireTab(t: Tab): void {
    const wc = t.wc;
    t.subs.push(
      t.control.onChange((state, via) => {
        this.emitter.emit("controlChanged", { tabId: t.id, state, via });
        this.scheduleState();
      }),
    );
    wc.on("before-input-event", (_e, input) => {
      t.control.onBeforeInputEvent(input.type);
      // CDP `Input.*` never fires before-input-event: a key here is always the owner.
      if (input.type === "keyDown" || input.type === "rawKeyDown") {
        this.emitter.emit("ownerInput", undefined);
      }
    });
    wc.on("input-event", (_e, ev) => {
      t.control.onInputEvent(ev.type);
      // A click is the owner's only while none of the agent's Input.* commands is in flight
      // (its mouse echoes arrive inside the sendCommand await; take-control.ts).
      if (ev.type === "mouseDown" && t.control.agentInputDepth === 0) {
        this.emitter.emit("ownerInput", undefined);
      }
    });

    // Only http(s) in agent tabs (security §6); the Gateway's BrowserDriver applies origin sets.
    wc.on("will-navigate", (details) => {
      if (!this.allowNavigation(t, details.url)) details.preventDefault();
    });
    wc.on("will-redirect", (details) => {
      if (details.isMainFrame && !this.allowNavigation(t, details.url)) details.preventDefault();
    });
    wc.on("will-frame-navigate", (details) => {
      if (details.isMainFrame && !this.allowNavigation(t, details.url)) details.preventDefault();
    });
    // Context ids are per renderer process: forget isolated worlds before a cross-document
    // main-frame navigation can swap processes (see CdpPolicy).
    wc.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) t.policy.reset();
    });
    wc.on("render-process-gone", () => {
      t.policy.reset();
      this.updated(t);
    });
    wc.on("did-navigate", () => {
      t.navigated = true;
      this.updated(t);
    });
    wc.on("did-navigate-in-page", (_e, _url, isMainFrame) => {
      if (isMainFrame) this.updated(t);
    });
    wc.on("page-title-updated", () => this.updated(t));
    wc.on("did-start-loading", () => this.scheduleState());
    wc.on("did-stop-loading", () => this.scheduleState());
    wc.on("zoom-changed", () => this.scheduleState());
    wc.on("destroyed", () => this.removeTab(t));

    wc.setWindowOpenHandler((details) => {
      if (!isAllowedNavigationUrl(details.url) && details.url !== "about:blank")
        return { action: "deny" };
      return {
        action: "allow",
        overrideBrowserWindowOptions: { show: false, webPreferences: tabPrefs(t.partition) },
        // Adopt the popup into a new tab so window.opener, the partition and CDP survive (OAuth).
        createWindow: (options) => {
          const adopted = (options as { webContents?: WebContents }).webContents;
          const child = this.createTab({
            partition: t.partition,
            profile: t.profile,
            openerTabId: t.id,
            disposition: details.disposition,
            taskId: t.taskId,
            taskTitle: t.taskTitle,
            background: details.disposition === "background-tab",
            ...(adopted === undefined ? {} : { webContents: adopted }),
          });
          if (adopted === undefined) void child.wc.loadURL(details.url).catch(() => {});
          return child.wc;
        },
      };
    });

    const dbg = wc.debugger;
    dbg.on("message", (_e, method: string, params: unknown, sessionId: string) => {
      const sid = sessionId === "" ? undefined : sessionId;
      t.policy.observeEvent(method, params, sid);
      const domain = method.slice(0, method.indexOf("."));
      if (!t.enabled.has(domainKey(sid, domain))) return;
      if (method === "Page.screencastFrame" && !t.screencast.has(sid ?? "")) return;
      // Cookies and Authorization headers never leave the desktop (review finding).
      const filtered = filterCdpEvent(method, params);
      if (filtered === null) return;
      this.emitter.emit("cdpEvent", {
        tabId: t.id,
        method,
        params: filtered,
        ...(sid === undefined ? {} : { sessionId: sid }),
      });
    });
    dbg.on("detach", (_e, reason: string) => {
      t.attached = false;
      t.policy.reset();
      t.enabled.clear();
      t.screencast.clear();
      const requested = t.detachRequested;
      t.detachRequested = false;
      if (t.closing || wc.isDestroyed()) return;
      if (!requested) this.emitter.emit("debuggerDetached", { tabId: t.id, reason });
      this.updated(t);
    });
  }

  private attachDebugger(t: Tab): void {
    if (t.wc.isDestroyed()) return;
    if (!t.wc.debugger.isAttached()) t.wc.debugger.attach("1.3");
    t.attached = true;
  }

  async attach(tabId: string): Promise<BridgeTab> {
    const t = this.need(tabId);
    if (!t.attached || !t.wc.debugger.isAttached()) {
      try {
        this.attachDebugger(t);
      } catch (err) {
        throw new PsycheError("debugger_detached", "could not attach the debugger", {
          retryable: true,
          details: { reason: err instanceof Error ? err.message : String(err) },
        });
      }
      this.updated(t);
    }
    return this.bridgeTab(t);
  }

  async detach(tabId: string): Promise<void> {
    const t = this.need(tabId);
    if (!t.wc.debugger.isAttached()) return;
    t.detachRequested = true;
    t.wc.debugger.detach();
  }

  // ── CDP ─────────────────────────────────────────────────────────────────────────────────

  async cdpSend(
    tabId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<unknown> {
    const t = this.need(tabId);
    if (!t.attached || !t.wc.debugger.isAttached())
      throw new PsycheError("debugger_detached", `debugger is not attached to ${tabId}`, {
        retryable: true,
        details: { reason: "detached" },
      });
    const decision = t.policy.check(method, params, sessionId);
    if (!decision.ok) throw new PsycheError("method_not_allowed", decision.reason);
    const isInput = method.startsWith("Input.");
    const refuseWhileUser = () => {
      // Input and page-changing calls wait for the user: "user input pauses the agent at once".
      if (isAgentActionMethod(method) && t.control.isUserInControl())
        throw new PsycheError("user_in_control", "the user is in control of this tab", {
          retryable: true,
        });
    };
    refuseWhileUser();
    if (isInput) {
      // One agent Input.* at a time per tab, so the in-flight window that hides user mouse
      // events stays one command long.
      const run = t.inputChain.then(
        () => this.sendChecked(t, method, params, sessionId, refuseWhileUser),
        () => this.sendChecked(t, method, params, sessionId, refuseWhileUser),
      );
      t.inputChain = run.catch(() => undefined);
      return run;
    }
    return this.sendChecked(t, method, params, sessionId, refuseWhileUser);
  }

  private async sendChecked(
    t: Tab,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined,
    refuseWhileUser: () => void,
  ): Promise<unknown> {
    refuseWhileUser();
    const isInput = method.startsWith("Input.");
    const generation = t.policy.generation;
    let result: unknown;
    if (isInput) t.control.agentInputStart(method, params);
    try {
      result = await t.wc.debugger.sendCommand(method, params ?? {}, sessionId);
    } catch (err) {
      if (t.wc.isDestroyed() || !t.wc.debugger.isAttached())
        throw new PsycheError("debugger_detached", "the debugger detached during the command", {
          retryable: true,
          details: { reason: "detached" },
        });
      throw new PsycheError("internal", err instanceof Error ? err.message : "CDP command failed", {
        details: { cdp: true },
      });
    } finally {
      if (isInput) t.control.agentInputEnd(method, params);
    }
    t.policy.observeResult(method, params, result, {
      generation,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    this.trackDomains(t, method, sessionId);
    return result ?? {};
  }

  /** Only events of domains the Gateway enabled are forwarded (amendment 4). */
  private trackDomains(t: Tab, method: string, sessionId: string | undefined): void {
    const dot = method.indexOf(".");
    const domain = method.slice(0, dot);
    const verb = method.slice(dot + 1);
    if (verb === "enable") t.enabled.add(domainKey(sessionId, domain));
    else if (verb === "disable") t.enabled.delete(domainKey(sessionId, domain));
    if (method === "Page.startScreencast") t.screencast.add(sessionId ?? "");
    else if (method === "Page.stopScreencast") t.screencast.delete(sessionId ?? "");
  }

  // ── status pill and highlight ───────────────────────────────────────────────────────────

  async setStatus(tabId: string, text: string | null, highlight?: BridgeHighlight): Promise<void> {
    const t = this.need(tabId);
    t.status = text;
    this.scheduleState();
    if (highlight === undefined || !t.attached || t.wc.isDestroyed()) return;
    const dbg = t.wc.debugger;
    const rect = {
      x: Math.round(highlight.x),
      y: Math.round(highlight.y),
      width: Math.round(highlight.width),
      height: Math.round(highlight.height),
      color: HIGHLIGHT_FILL,
      outlineColor: HIGHLIGHT_OUTLINE,
    };
    try {
      await dbg.sendCommand("Overlay.highlightRect", rect);
    } catch {
      // Overlay needs DOM enabled first; enable both (our own, not forwarded) and retry once.
      try {
        await dbg.sendCommand("DOM.enable");
        await dbg.sendCommand("Overlay.enable");
        await dbg.sendCommand("Overlay.highlightRect", rect);
      } catch {
        return;
      }
    }
    clearTimeout(t.highlightTimer);
    t.highlightTimer = setTimeout(() => {
      t.highlightTimer = undefined;
      if (!t.wc.isDestroyed() && t.wc.debugger.isAttached())
        void t.wc.debugger.sendCommand("Overlay.hideHighlight").catch(() => {});
    }, HIGHLIGHT_MS);
  }

  // ── renderer-facing controls ────────────────────────────────────────────────────────────

  /** Lays the active tab's view at `rect`; null hides every tab. Hidden tabs keep running. */
  setViewport(rect: Rect | null): void {
    this.viewport = rect;
    if (rect !== null && rect.width > 0 && rect.height > 0) this.lastBounds = rect;
    this.layout();
  }

  private paneShown: boolean | undefined;

  /**
   * Recomputes whether the pane is on screen: a viewport, and a window that is shown and not
   * minimized. `main.ts` calls it on window show / hide / minimize / restore too.
   */
  refreshVisibility(): void {
    const shown =
      !this.win.isDestroyed() &&
      this.viewport !== null &&
      this.win.isVisible() &&
      !this.win.isMinimized();
    if (shown === this.paneShown) return;
    this.paneShown = shown;
    this.emitter.emit("paneVisible", shown);
  }

  private layout(): void {
    this.refreshVisibility();
    if (this.win.isDestroyed()) return;
    for (const t of this.tabs.values()) {
      if (t.popOut !== undefined) continue;
      // Hidden tabs keep realistic bounds so pages lay out and screencast at the pane's size.
      t.view.setBounds(this.lastBounds);
      t.view.setVisible(this.viewport !== null && t.id === this.active);
    }
  }

  async navigate(tabId: string, action: BrowserNav): Promise<void> {
    const t = this.need(tabId);
    const wc = t.wc;
    switch (action) {
      case "back":
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        break;
      case "forward":
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        break;
      case "reload":
        wc.reload();
        break;
      case "stop":
        wc.stop();
        break;
      case "zoomIn":
      case "zoomOut": {
        const z = wc.getZoomFactor();
        const next =
          action === "zoomIn"
            ? (ZOOM_STEPS.find((s) => s > z + 0.001) ?? z)
            : ([...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? z);
        wc.setZoomFactor(next);
        break;
      }
      case "zoomReset":
        wc.setZoomFactor(1);
        break;
    }
    this.scheduleState();
  }

  async find(tabId: string, text: string, opts: { forward?: boolean } = {}): Promise<void> {
    const t = this.need(tabId);
    if (text === "") return this.stopFind(tabId);
    t.wc.findInPage(text, { forward: opts.forward ?? true, findNext: t.lastFind === text });
    t.lastFind = text;
  }

  async stopFind(tabId: string): Promise<void> {
    const t = this.need(tabId);
    t.lastFind = null;
    t.wc.stopFindInPage("clearSelection");
  }

  /** Sticky Take control (the button) or Release. */
  async setControl(tabId: string, take: boolean): Promise<void> {
    this.need(tabId).control.setSticky(take);
  }

  /** Moves a tab into its own window, or back into the pane when it is already out. */
  async popOut(tabId: string, fullScreen = false): Promise<void> {
    const t = this.need(tabId);
    if (t.popOut !== undefined && !t.popOut.isDestroyed()) {
      t.popOut.close();
      return;
    }
    const b = this.lastBounds;
    const w = new BaseWindow({
      width: Math.max(480, b.width),
      height: Math.max(360, b.height),
      title: t.wc.getTitle() || "Psyche browser",
    });
    this.win.contentView.removeChildView(t.view);
    w.contentView.addChildView(t.view);
    t.popOut = w;
    const fit = () => {
      const { width, height } = w.getContentBounds();
      t.view.setBounds({ x: 0, y: 0, width, height });
    };
    fit();
    t.view.setVisible(true);
    w.on("resize", fit);
    // Move the view back before the window goes away so its WebContents survives.
    w.on("close", () => {
      t.popOut = undefined;
      if (!this.tabs.has(t.id) || t.wc.isDestroyed()) return;
      try {
        w.contentView.removeChildView(t.view);
        if (!this.win.isDestroyed()) this.win.contentView.addChildView(t.view);
      } catch {
        // Window teardown raced us; the tab closes with it.
      }
      this.layout();
      this.scheduleState();
    });
    if (fullScreen) w.setFullScreen(true);
    this.scheduleState();
  }

  async clearBrowsingData(profile: BridgeProfile): Promise<void> {
    const partitions =
      profile === "logged-in" ? [loggedInPartition(this.profileName)] : [...this.cleanPartitions];
    for (const p of partitions) {
      const ses = session.fromPartition(p);
      await ses.clearStorageData();
      await ses.clearCache();
    }
  }

  // ── downloads ───────────────────────────────────────────────────────────────────────────

  private onWillDownload(event: Electron.Event, item: DownloadItem, wc: WebContents): void {
    const t = this.byWebContents.get(wc.id);
    let path: string;
    try {
      if (t === undefined) throw new Error("download from outside an agent tab");
      ensureQuarantineDir(this.home);
      path = quarantinePath(this.home, item.getFilename());
      // Must happen synchronously inside the event (Electron docs).
      item.setSavePath(path);
    } catch {
      event.preventDefault();
      return;
    }
    const tabId = t.id;
    const downloadId = `dl_${this.nextDownload++}`;
    const filename = item.getFilename();
    const url = item.getURL();
    const mime = item.getMimeType() || null;
    const emit = (state: "started" | "completed" | "failed" | "cancelled") => {
      this.emitter.emit("download", {
        notice: { downloadId, tabId, filename, state, quarantined: true },
        payload: {
          tabId,
          downloadId,
          url,
          filename,
          mime,
          state,
          bytes: state === "started" ? null : item.getReceivedBytes(),
          quarantinePath: state === "completed" || state === "started" ? path : null,
          at: new Date().toISOString(),
        },
      });
    };
    emit("started");
    item.once("done", (_e, state) => {
      if (state === "completed") {
        void setQuarantineAttribute(path).finally(() => emit("completed"));
      } else emit(state === "cancelled" ? "cancelled" : "failed");
    });
  }

  // ── teardown ────────────────────────────────────────────────────────────────────────────

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.stateTimer);
    for (const t of [...this.tabs.values()]) {
      t.closing = true;
      if (!t.wc.isDestroyed()) t.wc.close();
      this.removeTab(t);
    }
  }
}
