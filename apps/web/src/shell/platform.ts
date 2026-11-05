import type { BridgeControlState, BridgeProfile } from "@psyche/protocol";
import type { SandboxPcSlot } from "@psyche/ui";
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
  /** This window's device id (the desktop main process's, or this browser's stored key). */
  deviceId?(): Promise<string | undefined>;
  /** Desktop only: the Gateway process the app starts (LaunchAgent or dev child). */
  getRun?(): Promise<GatewayRunView>;
  onRun?(cb: (run: GatewayRunView) => void): Unsubscribe;
  /** Desktop only: opens `$PSYCHE_HOME/logs` (gateway.out.log, gateway.err.log). */
  showLogs?(): Promise<void>;
  /** Desktop only: starts the Gateway again after a failed start (the splash's Retry). */
  retry?(): Promise<void>;
}

/** A Gateway this computer can connect to (apps/desktop/src/main/gateway-manager.ts). */
export interface SavedGatewayView {
  id: string;
  name: string;
  /** The address; null for This Mac. */
  origin: string | null;
  /** A Gateway on another computer. */
  remote: boolean;
  active: boolean;
  /** The Gateway's identity key is pinned. */
  pinned: boolean;
  /** On the local network, reached over a pinned self-signed certificate. */
  lan?: boolean;
}

/** A Gateway the network announced (Bonjour `_psyche._tcp`); a claim, not a proof. */
export interface DiscoveredGatewayView {
  /** Stable for this listing; the window adds it by this id, never by an address. */
  id: string;
  name: string;
  /** `sha256:<hex>` the Gateway announced for its identity key, or null. */
  fingerprint: string | null;
  /** Announced more than once with different keys: not addable. */
  conflict: boolean;
  /** Already in the saved list. */
  saved: boolean;
}

/** Why an address was refused when adding a Gateway. */
export type GatewayAddressProblem =
  | "empty"
  | "invalid"
  | "needs_full_name"
  | "needs_https"
  | "has_path"
  | "has_credentials"
  | "link_not_a_pairing_link"
  | "link_unsupported_version"
  | "link_malformed"
  | "link_extra_fields"
  | "link_bad_field"
  | "link_pin_mismatch"
  | "link_lan"
  | "link_not_lan";

/**
 * Desktop only: the saved Gateways (remote-gateway design §1.3). One is active at a time;
 * switching restarts the app on the other one so nothing from the first carries over. Adding,
 * forgetting and pairing again are confirmed in a native dialog the window cannot draw.
 */
export interface GatewaysPort {
  list(): Promise<SavedGatewayView[]>;
  /** Rejects with `invalid_params` and `details.problem` (`GatewayAddressProblem`) for a bad address. */
  add(address: string, name?: string): Promise<SavedGatewayView>;
  /** Looks for Gateways on the local network (on the owner's click, a few seconds). */
  discover?(): Promise<DiscoveredGatewayView[]>;
  /** Adds a listing `discover` returned; the same native confirmation and pin flow as `add`. */
  addDiscovered?(id: string): Promise<SavedGatewayView>;
  rename(id: string, name: string): Promise<void>;
  /** Forgets the Gateway: its pin, this computer's key for it and its stored data. */
  remove(id: string): Promise<void>;
  /** Restarts the app on that Gateway; `stopLocal` also stops this Mac's own Gateway first. */
  switchTo(id: string, opts?: { stopLocal?: boolean }): Promise<void>;
  /** Drops the pin and this computer's key for the Gateway so it pairs again as a new device. */
  repair(id: string): Promise<void>;
  /**
   * Adds the Gateway a pasted `psyche-pair:v1` link names. Main parses the link itself and asks in
   * a native dialog that names the normalized address. Rejects with `invalid_params` and
   * `details.problem` (`GatewayAddressProblem` or `link_<problem>`).
   */
  addLink?(link: string): Promise<SavedGatewayView>;
  /**
   * A `psyche-pair:` link the OS opened in the app, once: the Add a Gateway field shows it for the
   * owner to review and press Add. Nothing is connected by opening it.
   */
  takePendingLink?(): Promise<string | null>;
  /** The OS opened a pairing link while this window is open: ask `takePendingLink`. */
  onPendingLink?(cb: () => void): Unsubscribe;
}

/** The desktop supervisor's view of the Gateway process (apps/desktop/src/main/supervisor.ts). */
export type GatewayRunView =
  | { kind: "unknown" }
  | { kind: "starting"; mode: string; step?: "installing" | "waiting" }
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
  /** Renderer closed after a long idle to free RAM; it reloads on open. */
  discarded?: boolean;
}

/**
 * A question under the pane after the owner signed in inside an agent tab. Never carries a
 * password: the pane draws a mask and main holds the value.
 */
export type BrowserPromptView =
  | { id: string; tabId: string; kind: "stay_signed_in"; origin: string; hosts: string[] }
  | {
      id: string;
      tabId: string;
      kind: "save_login";
      origin: string;
      username: string;
      /** Short code of the last failed save (`vault_locked`, `forbidden`, …). */
      error?: string;
    };

export type BrowserPromptAnswer = "accept" | "dismiss" | "never";

/** A site the owner chose to stay signed in to (Settings → Browser). */
export interface SignedInSiteView {
  origin: string;
  hosts: string[];
  addedAt: string;
  /** Found from the profile's cookies rather than chosen with "Stay signed in". */
  detected?: boolean;
}

export interface BrowserHostState {
  tabs: BrowserTabView[];
  /** Sign-in questions waiting for the owner; absent on hosts without them. */
  prompts?: BrowserPromptView[];
  activeTabId: string | null;
  /** The Gateway's CDP driver is connected over the bridge socket. */
  bridgeConnected: boolean;
  /**
   * The owner is recording a task (teach by showing): the tab, the steps so far, and why it ended
   * if it ended without Stop. Absent or null when nothing is recorded.
   */
  recording?: { tabId: string; steps: number; ended?: "limit" | "interrupted" } | null;
}

/**
 * One step as the recorder captured it, for the review screen. `sample` is what the owner typed
 * into an ordinary field; it never exists for a sensitive field. It stays in this window until
 * Save, and Save sends it only where the owner chose to keep it.
 */
export interface TeachCapturedStep {
  id: string;
  kind: "navigate" | "click" | "type" | "select" | "press" | "app_click" | "app_type" | "app_menu";
  url?: string;
  role?: string;
  name?: string;
  selector?: string;
  /** Mac app steps: the app, the titles down to the element (or the menu path) and a fallback. */
  app?: { bundleId: string; name: string };
  path?: string[];
  fallback?: string;
  key?: string;
  sensitive?: boolean;
  sample?: string;
}

/** What Stop hands the review screen. */
export interface TeachCapture {
  id: string;
  endedBy: "stop" | "limit" | "interrupted" | "timeout" | "cancel";
  steps: TeachCapturedStep[];
  /** Page changes the page made by itself, left out of the steps. */
  skippedNavigations?: number;
  /** A recording made in a Mac app: which one, and how much input was left out. */
  app?: { bundleId: string; name: string };
  skippedInput?: number;
}

/** An app the owner can record in (granted for computer use, not off limits). */
export interface TeachAppChoiceView {
  bundleId: string;
  name: string;
  tier: "read" | "click" | "interact";
}

/** The Mac helper's recording, as the pane shows it. */
export interface TeachAppStatusView {
  active: boolean;
  app?: { bundleId: string; name: string };
  steps?: number;
  ended?: "stop" | "limit" | "timeout" | "cancel" | "interrupted";
}

/** A recording the owner chose to keep on this Mac: the reviewed steps only. */
export interface KeptRecordingView {
  id: string;
  title: string;
  keptAt: number;
  steps: import("@psyche/protocol").BrowserTeachStep[];
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
  /** Answers a sign-in prompt: Yes (`accept`), Not now (`dismiss`) or Never for this site. */
  answerPrompt?(promptId: string, action: BrowserPromptAnswer): Promise<void>;
  /** Sites kept signed in, in the persistent profile. */
  listSignedInSites?(): Promise<SignedInSiteView[]>;
  /** Sign out of a site: removes it from the list and deletes its cookies from the profile. */
  forgetSignedInSite?(origin: string): Promise<void>;
  /**
   * Opens the Psyche Chrome profile real-Chrome mode uses (feature I13) in Google Chrome, with
   * no DevTools port, so the owner can sign in there; resolves to the profile's directory.
   */
  openRealChromeProfile?(profile?: string): Promise<{ path: string }>;
  /**
   * Teach by showing (feature J8): Record, Stop and the kept recordings. Owner-only: they exist
   * only here, behind the pane's own buttons; the agent has no way to call them.
   */
  teachStart?(tabId: string): Promise<void>;
  teachStop?(): Promise<TeachCapture>;
  teachCancel?(): Promise<void>;
  /** Keeps the reviewed steps on this Mac. The recording is otherwise gone once it is saved. */
  teachKeep?(
    id: string,
    title: string,
    steps: import("@psyche/protocol").BrowserTeachStep[],
  ): Promise<KeptRecordingView>;
  /**
   * Teach by showing in a Mac app (J8 phase 2): the granted apps, Record, Stop, Cancel and status.
   * Owner-only like the rest: main asks the Gateway, which asks the Mac helper; the agent cannot.
   */
  teachAppApps?(): Promise<{ apps: TeachAppChoiceView[] }>;
  teachAppStart?(
    bundleId: string,
  ): Promise<{ sessionId: string; app: { bundleId: string; name: string } }>;
  teachAppStop?(): Promise<{
    id: string;
    endedBy: TeachCapture["endedBy"];
    app: { bundleId: string; name: string };
    steps: TeachCapturedStep[];
    skipped: number;
  }>;
  teachAppCancel?(): Promise<{ cancelled: boolean }>;
  teachAppStatus?(): Promise<TeachAppStatusView>;
  teachKept?(): Promise<KeptRecordingView[]>;
  /** Kept recordings are encrypted; without the OS keychain none is kept (`encrypted: false`). */
  teachStorage?(): Promise<{ encrypted: boolean }>;
  teachOpenKept?(id: string): Promise<KeptRecordingView>;
  teachDeleteKept?(id: string): Promise<void>;
}

export interface TerminalOpenResult {
  sessionId: string;
  /** `sandbox` (per-task container) or `host` (only when exec_host is on). */
  target: "sandbox" | "host";
  label: string;
}

/**
 * Desktop only: a terminal the shell only renders. On This Mac the main process runs the PTY
 * from what the Gateway answers; in a remote window the PTY runs on the Host and this port is a
 * session over the Gateway socket (`host-terminal-port.ts`), so nothing runs here.
 */
export interface TerminalPort {
  open(opts: {
    cwd?: string;
    threadId?: string;
    cols: number;
    rows: number;
    /** Called when opening waits for the owner's approval (a Host terminal needs presence). */
    onWaiting?: () => void;
  }): Promise<TerminalOpenResult | { unavailable: string }>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  close(sessionId: string): void;
  /** A listener may return a promise that settles once the data is rendered (flow control). */
  onData(cb: (sessionId: string, data: string) => void | Promise<void>): Unsubscribe;
  /** `exitCode` is -1 when the session was ended rather than the shell exiting. */
  onExit(cb: (sessionId: string, exitCode: number) => void): Unsubscribe;
}

/** Desktop only: native windows for pop-out panes and the quick-entry window. */
export interface WindowPort {
  popOutPane(route: string, title: string): Promise<void>;
  /** Raises the pop-out window for a pane route; false when it no longer exists. */
  focusPopOut?(route: string): Promise<boolean>;
  closeWindow(): void;
  /** Opens the Settings window on a section (⌘,; docs/design/redesign-2026.md §4). */
  openSettings?(section?: string): void;
  /**
   * From the Settings window: brings the main window forward with `text` in its composer, unsent
   * (Settings → Connectors "Try it", #677). Main relays it as a `prefillComposer` command.
   */
  prefillComposer?(text: string): void;
  /**
   * From the Settings window: brings the main window forward on `route` (Settings → About → "Run
   * setup again", which the Settings window cannot render). Main relays it as a `navigate` command.
   */
  openInMain?(route: string): void;
  /** Commands from the app menu, tray, deep links and global shortcuts. */
  onCommand(cb: (command: ShellCommand) => void): Unsubscribe;
}

/** Native → shell commands (menu, tray, `psyche://` deep links, notification clicks). */
export type ShellCommand =
  | { type: "navigate"; route: string }
  | { type: "newSideChat" }
  | { type: "palette" }
  /** ⌘W: closes a pop-out or quick-entry window, or leaves the current thread view. */
  | { type: "closeThreadView" }
  /** A pane's pop-out window was closed: dock the pane again (main window only). */
  | { type: "popOutClosed"; route: string }
  /** Fills the chat composer without sending (from the Settings window's "Try it", #677). */
  | { type: "prefillComposer"; text: string };

export interface NotifyPort {
  /** OS notification (desktop: mac helper when present, else Electron); web: none yet. */
  show(n: { id: string; title: string; body: string; route?: string }): void;
}

/**
 * Desktop only: how the host window is framed. `inset` means the window has no native title
 * bar (macOS `hiddenInset`): the shell draws a drag bar and keeps content clear of the traffic
 * lights, whose top-left corner is `trafficLights` (CSS pixels in the window). `overlay` is
 * Windows' `titleBarStyle: "hidden"` with `titleBarOverlay`: Windows draws minimise, maximise and
 * close at the top right, and the shell keeps clear of them with the Window Controls Overlay
 * CSS environment (`env(titlebar-area-*)`, `TitleBar.tsx`).
 */
export interface WindowChrome {
  titleBar: "inset" | "overlay" | "native";
  trafficLights?: { x: number; y: number };
  /**
   * Windows 11's Mica backdrop is under the window (`backgroundMaterial: "mica"`): the page keeps
   * its window background transparent where macOS would use vibrancy (the sidebar). Absent on
   * Windows 10, or when main could not set it: everything stays opaque.
   */
  material?: "mica";
  /** The main window opens on the startup splash (#539); main decides at launch. */
  splash?: boolean;
  /**
   * This app is a client of a Gateway on another computer (remote-gateway design §1.3): chat,
   * Search and the Library work as on This Mac, but the browser, computer use, folders, the
   * shell and the Apple apps are that Host's, so the shell names it and hides what cannot work.
   */
  remote?: { hostName: string };
  /** Packaged app with its own Gateway LaunchAgent: only then is Uninstall Psyche offered. */
  uninstall?: boolean;
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
  /** Desktop only: macOS privacy permissions for onboarding and Settings (issue #384). */
  permissions?: PermissionsPort;
  /** Desktop only: the bundled Mac helper the app launches (docs/archive/status/s14.md "Packaging"). */
  helper?: HelperPort;
  /** Desktop only: the macOS region format; the web uses the browser's language (A12). */
  locale?: LocalePort;
  /** Desktop only: opens an https page in the default browser; the web uses window.open (#505). */
  external?: ExternalPort;
  /** Desktop only: opens a cited source passage outside Psyche (Mail, Finder) through main. */
  sources?: SourcePort;
  /** Desktop only: the system clipboard through main; the web uses `navigator.clipboard` (#507). */
  clipboard?: ClipboardPort;
  /** Desktop only: macOS Reduce Transparency / Increase Contrast; the web reads media queries. */
  systemAppearance?: SystemAppearancePort;
  /** Desktop only: versions, platform and the data folder for Settings → About (#610). */
  app?: AppInfoPort;
  /** Desktop only: the saved Gateways and the switcher (remote-gateway design §1.3). */
  gateways?: GatewaysPort;
  /** Desktop on Windows: the sandbox PC's one-time setup (elevated service install, guest image). */
  sandboxPc?: SandboxPcSlot;
}

/**
 * What the desktop main process reports for Settings → About (#610). The web bakes its version
 * at build time and fetches `/version` on its own origin instead.
 */
export interface HostAppInfo {
  appVersion: string;
  /** `process.platform`, e.g. "darwin". */
  platform: string;
  /** `process.arch`: "arm64" or "x64". */
  arch: string;
  /** The OS version, e.g. "27.0.1". */
  osVersion: string;
  electronVersion: string;
  chromeVersion: string;
  /** PSYCHE_HOME or the default `~/.psyche`. */
  psycheHome: string;
  /** The Gateway's HTTP origin. */
  gatewayOrigin: string;
  /** The Gateway's `/version` answer as main fetched it from `gatewayOrigin`, or null. */
  gateway: { name?: unknown; version?: unknown; protocolVersion?: unknown } | null;
}

export interface AppInfoPort {
  info(): Promise<HostAppInfo>;
  /** Shows the data folder in Finder. Absent for a client of another computer's Gateway. */
  revealHome?(): Promise<void>;
  /**
   * Uninstall Psyche (design updates-and-install §3.5). Desktop shell on this Mac only: absent
   * on the web and for a client of another computer's Gateway.
   */
  uninstallPlan?(req: {
    deleteData: boolean;
    removeKeychain?: boolean;
  }): Promise<UninstallPlanView>;
  /**
   * Stops the agent and the helper, moves what the plan listed to the Trash, then quits. With
   * `deleteData` it needs the typed word and fresh presence: the first call rejects with
   * `approval_required` and `details.approvalId`; call again with that `approvalId` once approved.
   */
  uninstall?(req: {
    deleteData: boolean;
    removeKeychain?: boolean;
    confirm?: string;
    approvalId?: string;
  }): Promise<void>;
}

/** What uninstalling would do right now, as main lists it. */
export interface UninstallPlanView {
  /** Everything that is stopped, unregistered or turned off. */
  stops: { kind: string; label: string }[];
  /** Everything moved to the Trash, as absolute paths. */
  trash: { kind: string; path: string; label: string }[];
  /** The word to type before deleting data. */
  confirmWord: string;
  /** Who owns the Gateway LaunchAgent: only "ours" is stopped and removed. */
  agent: "ours" | "other" | "none";
  /** Keychain services that will be removed (only with the data, only when asked). */
  keychain: string[];
  /** Plain-words notes from main (a PSYCHE_HOME that differs from the agent's). */
  warnings: string[];
  /** Why this cannot run right now; empty when it can. */
  blockers: { path: string; reason: string }[];
}

export interface SystemAppearance {
  reduceTransparency: boolean;
  highContrast: boolean;
}

export interface SystemAppearancePort {
  get(): Promise<SystemAppearance>;
  on(cb: (a: SystemAppearance) => void): Unsubscribe;
}

export interface ClipboardPort {
  /** `clearAfterMs`: clear the clipboard again after that long if it still holds `text`. */
  writeText(text: string, opts?: { clearAfterMs?: number }): Promise<void>;
}

/** The system's locales as macOS reports them (`app.getSystemLocale()`, preferred languages). */
export interface SystemLocale {
  /** The region format, e.g. "en-GB": numbers, dates and times. */
  system: string;
  /** Preferred languages, most preferred first: which catalogue to show once more ship. */
  preferred: string[];
}

export interface ExternalPort {
  open(url: string): Promise<void>;
}

/**
 * Desktop only: opens the original of a cited passage (a mail message in Mail, a file in a
 * granted folder in Finder) from its search document id. The host resolves the target itself.
 * Resolves to what it opened; "none" when there is nothing safe to open (show the viewer).
 */
export interface SourcePort {
  open(docId: string): Promise<"mail" | "file" | "none">;
}

export interface LocalePort {
  get(): Promise<SystemLocale>;
}

/** The desktop's view of its bundled Mac helper (apps/desktop/src/main/helper-launcher.ts). */
export type MacHelperState =
  | { kind: "unbundled" }
  | { kind: "starting" }
  | { kind: "paired" }
  | { kind: "offline"; reason?: string };

export interface HelperPort {
  getState(): Promise<MacHelperState>;
  onState(cb: (state: MacHelperState) => void): Unsubscribe;
  /** Starts the bundled helper now and resolves once it paired or timed out. */
  launch?(): Promise<MacHelperState>;
  /**
   * Touch ID through the bundled helper (security §3.7, §10), on main's own channels, which only
   * the main and Settings windows reach: what the bundled helper says about itself, registering
   * exactly that key, and approving a card once with it.
   */
  touchId?: TouchIdPort;
}

/** What the helper inside this app reports (`psyche-helper --print-identity`). */
export interface BundledHelperIdentity {
  deviceId: string;
  keyId?: string;
  /** `windows_hello` from the Windows helper; its `algorithm` is e.g. "RSA-2048". */
  kind?: "keychain" | "enclave_file" | "windows_hello";
  algorithm?: string;
  error?: string;
}

export interface TouchIdPort {
  identity(): Promise<BundledHelperIdentity | null>;
  register(): Promise<unknown>;
  approve(params: { approvalId: string; answerToken: string }): Promise<unknown>;
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

/**
 * Desktop only: macOS privacy permissions (issue #384), and on Windows the microphone privacy
 * toggle (`request("microphone")` opens Settings → Privacy & security → Microphone). Windows has
 * no Accessibility or Screen Recording grant: main answers those `granted`.
 */
export type PermissionKind = "accessibility" | "screenRecording" | "notifications" | "microphone";
export type PermissionState = "granted" | "denied" | "not_determined" | "unavailable";

export interface PermissionsPort {
  /** Every permission's state, without prompting. */
  status(): Promise<Partial<Record<PermissionKind, PermissionState>>>;
  /** Shows the macOS prompt, or opens the System Settings pane, and answers the new state. */
  request(kind: PermissionKind): Promise<PermissionState>;
}

export interface DictationPort {
  getStatus(): Promise<SystemDictationStatus>;
  onStatus(cb: (status: SystemDictationStatus) => void): () => void;
  /** Re-arms the watch (after the owner granted Accessibility) and answers the new status. */
  recheck(): Promise<SystemDictationStatus>;
  /** Opens System Settings › Privacy & Security › Accessibility. */
  openAccessibilitySettings(): void;
  /** Whether another app holds a shortcut, asked before Settings saves the toggle hotkey. */
  checkHotkey?(
    accelerator: string,
    /** Which shortcut it is for: dictation's toggle (default), Ask about screen or quick entry. */
    purpose?: "dictation" | "screenAsk" | "quickEntry",
  ): Promise<"ok" | "taken" | "invalid">;
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
