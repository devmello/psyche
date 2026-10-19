import type {
  BrowserDriver,
  CallOptions,
  DriverEvent,
  NavigateResult,
  PageSnapshot,
  ResolvedSecret,
  SnapshotRef,
  Unsubscribe,
} from "@psyche/protocol";
import type { OriginPolicy, OriginPolicyOptions } from "./origin/policy.ts";

/**
 * Extensions to the protocol's `BrowserDriver` that the M1 tools need (prompt S08 mission).
 * Everything here is additive; the matching optional methods are proposed for
 * `packages/protocol` in a `protocol:` PR (see docs/status/s08.md). Until that merges the
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
  close(): void | Promise<void>;
}

export type DriverEventEx =
  | DriverEvent
  | { type: "blocked"; tabId: string; url: string; reason: string }
  | { type: "approval_needed"; tabId: string; url: string; origin: string; hop: string }
  | { type: "secure_field"; tabId: string; active: boolean }
  | { type: "popup"; tabId: string; openerTabId: string; url: string }
  | { type: "captcha"; tabId: string; url: string };

export interface OpenSessionOptions {
  profileId?: string;
  taskId?: string;
  partition?: "profile" | "clean";
  /** The task's origin policy; a fresh empty policy (every origin needs approval) by default. */
  policy?: OriginPolicy | OriginPolicyOptions;
  /** Opt-in screencast recording for the session's tabs (feature I10). */
  recording?: RecordingSink;
}

export interface BrowserDriverEx extends BrowserDriver {
  openSession(options: OpenSessionOptions): ReturnType<BrowserDriver["openSession"]>;
  snapshot(tabId: string, options?: SnapshotOptions): Promise<BrowserSnapshot>;
  policy(sessionId: string): OriginPolicy;
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
  /** Current top-frame origin of a tab (canonical), or undefined before the first navigation. */
  tabOrigin(tabId: string): string | undefined;
  /**
   * Type a vault secret into `ref` (security §4.6): top-frame origin must equal `origin`, the
   * element must be the approved one, outside cross-origin frames, and the agent in control.
   * The value is never read back.
   */
  fillSecret(tabId: string, ref: string, secret: ResolvedSecret, origin: string): Promise<void>;
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
