import type { ViewPane, ViewPaneState } from "@psyche/protocol";

export type PanePlacement = ViewPaneState["placement"];

/**
 * Pane layout model (docs/06 §2.4, §4.1; architecture §5). Per thread: the chat is the fixed
 * center column and never a pane; beside it sit ordered pane GROUPS, each a tab strip with one
 * active pane. Two groups side by side only at ≥ 1440 px; below that one tab strip; below 720 px
 * one thing full screen at a time. Pure data: everything here is JSON-serializable.
 */

/** Every pane kind except the chat column. */
export type PaneKind = Exclude<ViewPane, "chat">;

/** Reserved id for the chat column in `view.*` and `view.report` (never a pane instance). */
export const CHAT_PANE_ID = "chat";

export interface PaneInstance {
  /** Stable: `p_<kind>_<n>` or caller-supplied. */
  paneId: string;
  pane: PaneKind;
  /** Pane-specific target (tab id, workspace path, artifact id); null = the pane's default. */
  target: string | null;
  threadId: string | null;
  taskId?: string;
  artifactId?: string;
  title?: string;
  /** The pane (null = chat) that had focus when this one opened; focus returns there on close. */
  openerPaneId: string | null;
  createdAt: string;
}

export interface PaneGroup {
  groupId: string;
  /** Tab order. Never empty. */
  paneIds: string[];
  activePaneId: string;
}

export interface LayoutState {
  version: 1;
  threadId: string | null;
  /** Creation order (the last of a kind is "the most recent"). Docked and popped panes alike. */
  panes: PaneInstance[];
  groups: PaneGroup[];
  /** One fraction of the pane area per group; sums to 1. */
  sizes: number[];
  /** Docked pane with focus; null = the chat column. */
  focusedPaneId: string | null;
  /** Panes living in their own window (not in any group). */
  popped: string[];
  /** Share of the content width the chat column keeps beside the pane area. */
  chatFraction: number;
}

export interface LayoutEnv {
  /** Window width in CSS px: picks the breakpoint. */
  width: number;
  /**
   * Width of the chat + pane area in CSS px (window minus rail and thread list); the 480 / 360 px
   * minimums are measured against it. Defaults to `width`.
   */
  contentWidth?: number;
  now: () => string;
  /** Unique suffix for generated ids (`p_<kind>_<id>`, `g_<id>`). */
  newId: () => string;
}

export type Breakpoint = "compact" | "medium" | "wide" | "xwide";

export const BREAKPOINT_MEDIUM = 720;
export const BREAKPOINT_WIDE = 1080;
export const BREAKPOINT_XWIDE = 1440;
export const CHAT_MIN_PX = 480;
export const PANE_MIN_PX = 360;
export const DEFAULT_CHAT_FRACTION = 0.5;
/** Most groups any width allows (two panes side by side). */
export const MAX_GROUPS = 2;

export type LayoutAction =
  | {
      type: "open";
      /** `"chat"` focuses the chat column. */
      pane: ViewPane;
      placement?: PanePlacement;
      target?: string | null;
      threadId?: string | null;
      taskId?: string;
      artifactId?: string;
      title?: string;
      /** Caller-supplied id; an existing pane with this id is revealed. */
      paneId?: string;
      /** Defaults to the focused pane (null = chat). */
      openerPaneId?: string | null;
      /** Default true: the opened (or revealed) pane takes focus. */
      focus?: boolean;
    }
  /** By id, or the most recent pane of a kind. */
  | { type: "close"; paneId?: string; pane?: ViewPane }
  /** By id, or the most recent pane of a kind; null / `"chat"` focuses the chat column. */
  | { type: "focus"; paneId?: string | null; pane?: ViewPane }
  | { type: "activateTab"; paneId: string }
  /** Moves a pane into a new group right after its own (only where two groups fit). */
  | { type: "split"; paneId: string }
  /** Drags a tab into another group (or reorders within its own); `index` defaults to the end. */
  | { type: "moveToGroup"; paneId: string; groupId: string; index?: number }
  /**
   * Drags a boundary by `delta` px (positive = rightward). Boundary 0 is the chat / pane-area
   * edge; boundary i ≥ 1 sits between group i-1 and group i.
   */
  | { type: "resize"; boundary: number; delta: number }
  | { type: "popOut"; paneId: string }
  /** Back into `groupId` (default: the first group). */
  | { type: "popIn"; paneId: string; groupId?: string }
  /** ⌘\ */
  | { type: "closeFocused" }
  | { type: "setTitle"; paneId: string; title: string }
  /** Re-fits to `env.width` (dispatch on window resize); every action also re-fits. */
  | { type: "fitToWidth" };

export type PresentationMode = "compact" | "single" | "double";

export interface PresentedGroup {
  groupId: string;
  paneIds: string[];
  activePaneId: string;
  size: number;
}

export interface Presentation {
  mode: PresentationMode;
  breakpoint: Breakpoint;
  /** Tab strips to render: none, one, or (double) two side by side. */
  groups: PresentedGroup[];
  /** The active pane of each rendered group (compact: at most the one on screen). */
  visiblePaneIds: string[];
  /** compact: the pane on screen (null = chat); otherwise the focused visible pane, else the first. */
  visiblePaneId: string | null;
  /** False only in compact mode while a pane fills the screen. */
  chatVisible: boolean;
  chatFraction: number;
  popped: string[];
}

export function emptyLayout(threadId: string | null = null): LayoutState {
  return {
    version: 1,
    threadId,
    panes: [],
    groups: [],
    sizes: [],
    focusedPaneId: null,
    popped: [],
    chatFraction: DEFAULT_CHAT_FRACTION,
  };
}

export function breakpointFor(width: number): Breakpoint {
  if (width < BREAKPOINT_MEDIUM) return "compact";
  if (width < BREAKPOINT_WIDE) return "medium";
  if (width < BREAKPOINT_XWIDE) return "wide";
  return "xwide";
}

/** How many groups fit: two only at ≥ 1440 px with room for chat + two 360 px panes. */
export function maxGroupsFor(width: number, contentWidth: number = width): number {
  if (width < BREAKPOINT_XWIDE) return 1;
  return contentWidth >= CHAT_MIN_PX + MAX_GROUPS * PANE_MIN_PX ? MAX_GROUPS : 1;
}

/** Deterministic id suffixes `1`, `2`, … (tests, or seeded from a persisted counter). */
export function counterIds(start = 1): () => string {
  let n = start;
  return () => String(n++);
}

/** Collision-resistant id suffixes for production. */
export function randomIds(): () => string {
  return () => {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid !== undefined) return uuid.replaceAll("-", "").slice(0, 12);
    return Math.random().toString(36).slice(2, 14);
  };
}

export function isPaneKind(pane: ViewPane): pane is PaneKind {
  return pane !== "chat";
}

export function findPane(state: LayoutState, paneId: string): PaneInstance | undefined {
  return state.panes.find((p) => p.paneId === paneId);
}

/** The most recently created pane of a kind (docked or popped). */
export function latestPaneOfKind(state: LayoutState, pane: ViewPane): PaneInstance | undefined {
  for (let i = state.panes.length - 1; i >= 0; i--) {
    const p = state.panes[i];
    if (p !== undefined && p.pane === pane) return p;
  }
  return undefined;
}

export function groupOf(state: LayoutState, paneId: string): PaneGroup | undefined {
  return state.groups.find((g) => g.paneIds.includes(paneId));
}

export function isPopped(state: LayoutState, paneId: string): boolean {
  return state.popped.includes(paneId);
}

export function isDocked(state: LayoutState, paneId: string): boolean {
  return groupOf(state, paneId) !== undefined;
}

/** Docked pane ids in on-screen order (group by group, tab by tab). */
export function dockedPaneIds(state: LayoutState): string[] {
  return state.groups.flatMap((g) => g.paneIds);
}
