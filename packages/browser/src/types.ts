import type {
  BrowserDriver,
  CallOptions,
  DriverEvent,
  DriverTab,
  FillElement,
  FillElementCheck,
  NavigateResult,
  PageSnapshot,
  RefBox,
  ResolvedSecret,
  SnapshotRef,
  Unsubscribe,
} from "@psyche/protocol";
import type { PartitionMode, PartitionReason, TabPartition } from "./origin/partition.ts";
import type { OriginPolicy, OriginPolicyOptions } from "./origin/policy.ts";
import type { RecordingEventInput } from "./recording/recorder.ts";

/**
 * Extensions to the protocol's `BrowserDriver` that the M1 tools need (prompt S08 mission).
 * Everything here is additive; the matching optional methods are proposed for
 * `packages/protocol` in a `protocol:` PR (see docs/archive/status/s08.md). Until that merges the
 * tools code against `BrowserDriverEx`, and both drivers implement it.
 */

export interface SnapshotOptions {
  /** Cap on `refs` (contract option). Default 400. */
  maxRefs?: number;
  /** Cap on `text` per page, in characters. Default 24,000 (about 6k tokens). */
  maxChars?: number;
  /** 1-based page of `text` when the tree is larger than `maxChars`. */
  page?: number;
  /** Drop subtrees entirely outside the viewport (landmarks kept). */
  viewportOnly?: boolean;
  /** Safety cap on raw tree depth (default 40; spike 04: depth 8 loses content). */
  maxDepth?: number;
}

export interface SnapshotStats {
  rawNodes: number;
  keptNodes: number;
  interactive: number;
  chars: number;
  approxTokens: number;
  fetchMs: number;
  buildMs: number;
}

/** A ref with fields the model sees plus a flag for interactive roles. */
export interface SnapshotRefEx extends SnapshotRef {
  interactive: boolean;
  /** Box is outside the current viewport. */
  offscreen?: boolean;
}

export interface BrowserSnapshot extends PageSnapshot {
  refs: SnapshotRefEx[];
  /** Rendered tree, YAML-like, one node per line; untrusted page content. */
  text: string;
  page: number;
  pages: number;
  /** Static text lines dropped to fit the cap; `readText` returns them. */
  omittedText?: number;
  /** A password / OTP / card field is focused or holds a value: screenshots are suppressed. */
  secureFieldActive: boolean;
  /**
   * Viewport boxes (CSS px) of frames whose content is hidden from the model; screenshots
   * paint them black. Not part of `text`.
   */
  hiddenFrameBoxes?: RefBox[];
  /** CSS viewport width the boxes refer to (screenshots scale by image width / this). */
  viewportWidth?: number;
  /** A CAPTCHA / bot challenge is on the page: the task pauses and the owner is asked (§6). */
  captcha?: boolean;
  stats: SnapshotStats;
}

/**
 * Element facts the tool layer uses to classify an action (submit vs plain click, purchase
 * path, secure field). Never model-visible.
 */
export interface ElementMeta {
  ref: string;
  role: string;
  name: string;
  tag: string;
  inputType?: string;
  autocomplete?: string;
  fieldName?: string;
  href?: string;
  /** The element is inside a form, or is associated with one through `form=`. */
  inForm: boolean;
  formAction?: string;
  formMethod?: string;
  /** Activating it submits a form (`<button>` in a form, `type=submit`, `input[type=image]`). */
  submits: boolean;
  /** Password, one-time-code, credit-card or similarly sensitive field. */
  secure: boolean;
  /** Origin of the document the element lives in. */
  frameOrigin: string;
  /** `target=_blank` or similar: activating it opens a popup. */
  opensPopup: boolean;
  /** The containing form also holds a password field (login forms; vault field-class rule). */
  formHasPassword?: boolean;
  maxLength?: number;
  inputMode?: string;
  contentEditable?: boolean;
}

export type ActionTarget = { ref: string } | { x: number; y: number };

export type PointerAction = "click" | "double_click" | "right_click" | "hover";

export interface ConsoleEntry {
  level: string;
  text: string;
  at: number;
}

export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  type?: string;
  status?: number;
  failed?: boolean;
  at: number;
}

export interface DialogInfo {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
}

/** A frame for the recording sink (screencast). */
export interface RecordingFrame {
  tabId: string;
  /** JPEG bytes. */
  data: Uint8Array;
  at: number;
  url: string;
}

export interface RecordingSink {
  frame(frame: RecordingFrame): void | Promise<void>;
  /** The event log beside the frames (I10); see `RecordingEventInput`. */
  event?(event: RecordingEventInput): void | Promise<void>;
  /** Flush; a tab closing calls it. */
  close(): void | Promise<void>;
  /** The session is over; may return the final index. */
  end?(): unknown;
}

export type DriverEventEx =
  | DriverEvent
  | { type: "blocked"; tabId: string; url: string; reason: string }
  | { type: "approval_needed"; tabId: string; url: string; origin: string; hop: string }
  | { type: "secure_field"; tabId: string; active: boolean }
  | { type: "popup"; tabId: string; openerTabId: string; url: string }
  | { type: "captcha"; tabId: string; url: string }
  /** Which partition a tab opened in and why (feature I15); the pane shows the label. */
  | {
      type: "tab_partition";
      tabId: string;
      partition: TabPartition;
      reason: PartitionReason;
      label: string;
    };

/** A tab with the partition it runs in (feature I15); `DriverTab` plus one field. */
export interface DriverTabEx extends DriverTab {
  partition: TabPartition;
}

export interface OpenSessionOptions {
  profileId?: string;
  taskId?: string;
  /**
   * `profile` (the owner's sign-ins), `clean` (ephemeral, "browse without my sign-ins") or
   * `auto` (the default: the profile only for tabs whose origin is in `signedInOrigins`,
   * `clean` for everything else). See `src/origin/partition.ts`.
   */
  partition?: PartitionMode;
  /** Origins the owner has signed into in the agent profile; `auto` mode uses the profile there. */
  signedInOrigins?: string[];
  /** Registrable domains the profile holds a live session for (found from its cookies), read per tab. */
  detectedDomains?: () => readonly string[];
  /** "Let Psyche use my signed-in sessions"; read per tab, default on. Off ignores `detectedDomains`. */
  useSignedInSessions?: () => boolean;
  /** The task's origin policy; a fresh empty policy (every origin needs approval) by default. */
  policy?: OriginPolicy | OriginPolicyOptions;
  /** Opt-in screencast recording for the session's tabs (feature I10). */
  recording?: RecordingSink;
}

export interface BrowserDriverEx extends BrowserDriver {
  openSession(options: OpenSessionOptions): ReturnType<BrowserDriver["openSession"]>;
  listTabs(sessionId: string): Promise<DriverTabEx[]>;
  openTab(sessionId: string, url?: string): Promise<DriverTabEx>;
  /**
   * Moves a `clean` tab of an `auto` session into the profile at `url` when the owner has a
   * session for that site (a tab opened blank, or a 401/403 in the clean partition). The old tab
   * closes; returns the new tab, or undefined when nothing applies. Writes still go through
   * approvals and taint as in any tab.
   */
  switchToProfile(tabId: string, url: string): Promise<DriverTabEx | undefined>;
  /** The partition a tab runs in (feature I15). */
  tabPartition(tabId: string): TabPartition;
  snapshot(tabId: string, options?: SnapshotOptions): Promise<BrowserSnapshot>;
  policy(sessionId: string): OriginPolicy;
  /** `clear` replaces the field's value (select-all, delete) before typing. */
  type(
    tabId: string,
    ref: string,
    text: string,
    options?: { submit?: boolean; clear?: boolean },
  ): Promise<void>;
  reload(tabId: string): Promise<NavigateResult>;
  pointer(tabId: string, target: ActionTarget, action: PointerAction): Promise<void>;
  /** Key chord like `Enter`, `Shift+Tab`, `Meta+A`; focuses `ref` first when given. */
  press(tabId: string, keys: string, options?: { ref?: string }): Promise<void>;
  drag(tabId: string, from: ActionTarget, to: ActionTarget): Promise<void>;
  scrollTo(tabId: string, ref: string): Promise<void>;
  /** Files are local paths the tool layer resolved from the Library; never model-supplied. */
  upload(tabId: string, ref: string, paths: string[]): Promise<void>;
  handleDialog(tabId: string, accept: boolean, promptText?: string): Promise<void>;
  pendingDialog(tabId: string): DialogInfo | undefined;
  describe(tabId: string, ref: string): Promise<ElementMeta>;
  /** Synchronous `describe` for `describeCall`; undefined when the ref is unknown or stale. */
  peek(tabId: string, ref: string): ElementMeta | undefined;
  /** The latest snapshot the model read of the tab's current document (purchase cards). */
  peekSnapshot(tabId: string): { text: string; url: string } | undefined;
  /** The session a tab belongs to. */
  sessionOf(tabId: string): string | undefined;
  /** After an approved `new_origin`: lift the content block or replay a stopped navigation. */
  retryBlocked(tabId: string): Promise<"unblocked" | "renavigated" | "unchanged">;
  /** Current top-frame origin of a tab (canonical), or undefined before the first navigation. */
  tabOrigin(tabId: string): string | undefined;
  /**
   * Type a vault secret into `ref` (security §4.6): top-frame origin must equal `origin`, the
   * element must be the approved one, outside cross-origin frames, and the agent in control.
   * The value is never read back.
   */
  fillSecret(
    tabId: string,
    ref: string,
    secret: ResolvedSecret,
    origin: string,
    /** The vault's field-class rule, applied to the live element right before typing (TM-28). */
    accepts?: (element: FillElement) => FillElementCheck,
  ): Promise<void>;
  /** Dev-preview tabs only (feature I12). */
  consoleMessages(tabId: string): ConsoleEntry[];
  networkLog(tabId: string): NetworkEntry[];
  wait(
    tabId: string,
    condition: Parameters<BrowserDriver["wait"]>[1],
    options?: CallOptions & { timeoutMs?: number },
  ): Promise<void>;
  /** Every event, including the extended ones; `onEvent` delivers only protocol `DriverEvent`s. */
  onEventEx(listener: (event: DriverEventEx) => void): Unsubscribe;
}
