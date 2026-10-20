import type { BridgeControlState, BridgeProfile } from "@psyche/protocol";
import type { CallOptions, GatewayEvent } from "../client/connection.ts";
import type { GatewayStatus } from "../client/status.ts";
import type { PasskeyHost } from "../lib/webauthn.ts";

/**
 * What the shared shell needs from its host. `apps/web` implements it over a browser WebSocket;
 * `apps/desktop` implements it over the preload bridge (`window.psyche`), where the main process
 * holds the Gateway connection and the native views. Optional members are desktop-only; the
 * shell hides what a host lacks (docs/06 §3.24).
 */

export type Unsubscribe = () => void;

export interface GatewayPort {
  getStatus(): Promise<GatewayStatus>;
  onStatus(cb: (status: GatewayStatus) => void): Unsubscribe;
  /** Any protocol method; the Gateway enforces scopes. Rejects with a `PsycheError`-shaped error. */
  call(method: string, params: unknown, options?: CallOptions): Promise<unknown>;
  onEvent(cb: (event: GatewayEvent) => void): Unsubscribe;
  /** Fired after reconnects and `seq` gaps: refetch collections (data model §11). */
  onResync(cb: () => void): Unsubscribe;
  /** Desktop only: the Gateway process the app starts (LaunchAgent or dev child). */
  getRun?(): Promise<GatewayRunView>;
  onRun?(cb: (run: GatewayRunView) => void): Unsubscribe;
  /** Desktop only: opens `$PSYCHE_HOME/logs` (gateway.out.log, gateway.err.log). */
  showLogs?(): Promise<void>;
}

/** The desktop supervisor's view of the Gateway process (apps/desktop/src/main/supervisor.ts). */
export type GatewayRunView =
  | { kind: "unknown" }
  | { kind: "starting"; mode: string }
  | { kind: "running"; mode: string; pid?: number }
  | { kind: "stopped"; mode: string; reason?: string; logs?: string };

/** CSS-pixel rectangle relative to the window's content area. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A tab of the embedded agent browser as the pane chrome shows it. */
export interface BrowserTabView {
  tabId: string;
  url: string;
  title: string;
  profile: BridgeProfile;
  controller: BridgeControlState;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  /** Status pill text from the Gateway (`bridge.tab.status`), null when idle. */
  status: string | null;
  taskId: string | null;
  taskTitle: string | null;
  openerTabId: string | null;
}

export interface BrowserHostState {
  tabs: BrowserTabView[];
  activeTabId: string | null;
  /** The Gateway's CDP driver is connected over the bridge socket. */
  bridgeConnected: boolean;
}

export type BrowserNav =
  | "back"
  | "forward"
  | "reload"
  | "stop"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset";

export interface DownloadNotice {
  downloadId: string;
  tabId: string;
  filename: string;
  state: "started" | "completed" | "failed" | "cancelled";
  quarantined: boolean;
}

/** Desktop only: the embedded browser host in the main process. */
export interface BrowserPort {
  getState(): Promise<BrowserHostState>;
  onState(cb: (state: BrowserHostState) => void): Unsubscribe;
  onDownload(cb: (d: DownloadNotice) => void): Unsubscribe;
  /** Where the active tab's native view goes; null hides every tab (pane closed or covered). */
  setViewport(rect: Rect | null): void;
  openTab(url: string, profile?: BridgeProfile): Promise<string>;
  closeTab(tabId: string): Promise<void>;
  activateTab(tabId: string): Promise<void>;
  navigate(tabId: string, action: BrowserNav): Promise<void>;
  find(tabId: string, text: string, opts?: { forward?: boolean }): Promise<void>;
  stopFind(tabId: string): Promise<void>;
  /** Sticky Take control (the button); user input also takes control implicitly. */
  setControl(tabId: string, take: boolean): Promise<void>;
  /** Moves a tab into its own window (Open in window) or back into the pane. */
  popOut(tabId: string, fullScreen?: boolean): Promise<void>;
  clearBrowsingData(profile: BridgeProfile): Promise<void>;
  /**
   * Opens the Psyche Chrome profile real-Chrome mode uses (feature I13) in Google Chrome, with
   * no DevTools port, so the owner can sign in there; resolves to the profile's directory.
   */
  openRealChromeProfile?(profile?: string): Promise<{ path: string }>;
}

export interface TerminalOpenResult {
  sessionId: string;
  /** `sandbox` (per-task container) or `host` (only when exec_host is on). */
  target: "sandbox" | "host";
  label: string;
}

/** Desktop only: PTYs whose target the Gateway chose; the shell only renders. */
export interface TerminalPort {
  open(opts: {
    cwd?: string;
    threadId?: string;
    cols: number;
    rows: number;
  }): Promise<TerminalOpenResult | { unavailable: string }>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  close(sessionId: string): void;
  onData(cb: (sessionId: string, data: string) => void): Unsubscribe;
  onExit(cb: (sessionId: string, exitCode: number) => void): Unsubscribe;
}

/** Desktop only: native windows for pop-out panes and the quick-entry window. */
export interface WindowPort {
  popOutPane(route: string, title: string): Promise<void>;
  closeWindow(): void;
  /** Commands from the app menu, tray, deep links and global shortcuts. */
  onCommand(cb: (command: ShellCommand) => void): Unsubscribe;
}

/** Native → shell commands (menu, tray, `psyche://` deep links, notification clicks). */
export type ShellCommand =
  | { type: "navigate"; route: string }
  | { type: "newSideChat" }
  | { type: "palette" }
  /** ⌘W: closes a pop-out or quick-entry window, or leaves the current thread view. */
  | { type: "closeThreadView" };

export interface NotifyPort {
  /** OS notification (desktop: mac helper when present, else Electron); web: none yet. */
  show(n: { id: string; title: string; body: string; route?: string }): void;
}

/**
 * Desktop only: how the host window is framed. `inset` means the window has no native title
 * bar (macOS `hiddenInset`): the shell draws a drag bar and keeps content clear of the traffic
 * lights, whose top-left corner is `trafficLights` (CSS pixels in the window).
 */
export interface WindowChrome {
  titleBar: "inset" | "native";
  trafficLights?: { x: number; y: number };
}

/** Desktop only: native file dialogs. The web host has none; the shell falls back to typed paths. */
export interface DialogPort {
  /** Opens the OS folder chooser; resolves to the folder's real path, or null when cancelled. */
  pickFolder(opts?: { title?: string }): Promise<string | null>;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface ShellPlatform {
  kind: "desktop" | "web";
  gateway: GatewayPort;
  storage: KeyValueStore;
  notify: NotifyPort;
  browser?: BrowserPort;
  terminal?: TerminalPort;
  windows?: WindowPort;
  chrome?: WindowChrome;
  dialogs?: DialogPort;
  dictation?: DictationPort;
  /** Web only, in a secure context: WebAuthn passkeys for presence (issue #79). */
  passkeys?: PasskeyHost;
}

/**
 * Desktop only: system-wide dictation (features J9, Q2), run by the desktop main process with the
 * Mac helper. `accessibility` is the helper's grant as its hold-to-talk watch found it.
 */
export interface SystemDictationStatus {
  helper: "online" | "offline";
  accessibility: "granted" | "missing" | "unknown";
  watching: boolean;
  hotkeyTaken?: string;
}

export interface DictationPort {
  getStatus(): Promise<SystemDictationStatus>;
  onStatus(cb: (status: SystemDictationStatus) => void): () => void;
  /** Re-arms the watch (after the owner granted Accessibility) and answers the new status. */
  recheck(): Promise<SystemDictationStatus>;
  /** Opens System Settings › Privacy & Security › Accessibility. */
  openAccessibilitySettings(): void;
  /** Whether another app holds a shortcut, asked before Settings saves the toggle hotkey. */
  checkHotkey?(accelerator: string): Promise<"ok" | "taken" | "invalid">;
}

/** localStorage-backed store that degrades to memory (private windows, blocked storage). */
export function browserStorage(): KeyValueStore {
  const memory = new Map<string, string>();
  return {
    get(key) {
      try {
        return globalThis.localStorage?.getItem(key) ?? memory.get(key) ?? null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    set(key, value) {
      memory.set(key, value);
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // memory copy is enough
      }
    },
  };
}
