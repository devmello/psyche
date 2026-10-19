import type { CallOptions, Unsubscribe } from "./Clock.ts";

/**
 * Browser driver contract (architecture §8; security §6; owner S08). One tool API, two drivers:
 * CDP over the desktop bridge and Playwright. Pages are represented as accessibility snapshots
 * with stable `ref_N` ids; every page-derived string is `untrusted`. While the user has taken
 * control (`controlState: "user"`) every agent action is refused (`conflict`).
 */

export type DriverProfileKind = "embedded" | "playwright" | "real_chrome";

export interface DriverProfile {
  id: string;
  name: string;
  kind: DriverProfileKind;
}

export type DriverControlState = "agent" | "user" | "paused";

export interface DriverSession {
  id: string;
  profileId: string;
  taskId?: string;
  /** Logged-in profile or a clean logged-out partition (shown in the pane). */
  partition: "profile" | "clean";
  controlState: DriverControlState;
}

export interface DriverTab {
  id: string;
  sessionId: string;
  url: string;
  title: string;
  active: boolean;
}

export interface RefBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapshotRef {
  /** `ref_N`, stable within one snapshot. */
  ref: string;
  role: string;
  name: string;
  value?: string;
  states?: string[];
  box?: RefBox;
}

export interface PageSnapshot {
  url: string;
  title: string;
  refs: SnapshotRef[];
  /** More refs exist than were returned (size cap). */
  truncated?: boolean;
  /** Tree is sparse (canvas, WebGL): a screenshot is suggested. */
  sparse?: boolean;
}

export interface NavigateResult {
  url: string;
  title: string;
  status?: number;
}

export type WaitCondition =
  | { kind: "load" }
  | { kind: "text"; text: string }
  | { kind: "ref"; ref: string }
  | { kind: "network_idle" }
  | { kind: "timeout"; ms: number };

export interface DriverDownload {
  id: string;
  filename: string;
  mime: string;
  size: number;
  /** Always true: downloads land in the Library quarantine, never auto-opened. */
  quarantined: true;
  libraryItemId?: string;
}

export type DriverEvent =
  | { type: "navigated"; tabId: string; url: string }
  | { type: "tab_opened" | "tab_closed"; tabId: string }
  | { type: "dialog"; tabId: string; message: string }
  | { type: "download"; tabId: string; download: DriverDownload }
  | { type: "control_state"; sessionId: string; state: DriverControlState };

export interface BrowserDriver {
  listProfiles(): Promise<DriverProfile[]>;
  openSession(options: {
    profileId?: string;
    taskId?: string;
    partition?: "profile" | "clean";
  }): Promise<DriverSession>;
  closeSession(sessionId: string): Promise<void>;
  listTabs(sessionId: string): Promise<DriverTab[]>;
  openTab(sessionId: string, url?: string): Promise<DriverTab>;
  focusTab(tabId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  navigate(tabId: string, url: string, options?: CallOptions): Promise<NavigateResult>;
  back(tabId: string): Promise<NavigateResult>;
  forward(tabId: string): Promise<NavigateResult>;
  snapshot(tabId: string, options?: { maxRefs?: number }): Promise<PageSnapshot>;
  find(tabId: string, query: string): Promise<SnapshotRef[]>;
  click(tabId: string, ref: string): Promise<void>;
  type(tabId: string, ref: string, text: string, options?: { submit?: boolean }): Promise<void>;
  select(tabId: string, ref: string, values: string[]): Promise<void>;
  scroll(
    tabId: string,
    options: { ref?: string; direction: "up" | "down" | "left" | "right"; amount?: number },
  ): Promise<void>;
  readText(
    tabId: string,
    options?: { maxChars?: number },
  ): Promise<{ text: string; truncated: boolean }>;
  screenshot(tabId: string): Promise<{ mime: "image/png" | "image/jpeg"; data: Uint8Array }>;
  download(tabId: string, source: { ref: string } | { url: string }): Promise<DriverDownload>;
  wait(tabId: string, condition: WaitCondition, options?: CallOptions): Promise<void>;
  getControlState(sessionId: string): Promise<DriverControlState>;
  /** Called by the desktop (Take control / release); never by the agent. */
  setControlState(sessionId: string, state: DriverControlState): Promise<void>;
  onEvent(listener: (event: DriverEvent) => void): Unsubscribe;
}
