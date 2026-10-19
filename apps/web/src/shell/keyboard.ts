/**
 * Keyboard map (docs/06 §4.11, feature E10) as data, so the shortcut sheet (⌘/), the command
 * palette and the key handler share one source. `mod` is ⌘ on macOS and Ctrl elsewhere.
 */

export type ShortcutAction =
  | "palette"
  | "newSideChat"
  | "closeThreadView"
  | "toggleThreadList"
  | "cycleThreads"
  | "forkSelection"
  | "stop"
  | "cycleDisclosure"
  | "openBrowserPane"
  | "openDiffPane"
  | "toggleTerminalPane"
  | "permissionMode"
  | "modelPicker"
  | "agentActivity"
  | "agentApprovals"
  | "closePane"
  | "shortcutList"
  | "approve"
  | "deny"
  | "quickEntry"
  | "pushToTalk";

export interface KeyChord {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

export interface Shortcut {
  action: ShortcutAction;
  label: string;
  chord: KeyChord;
  /** `app`: handled in the window; `global`: registered by the desktop main process. */
  scope: "app" | "global";
  /** Fires even while typing in the composer or another text field. */
  inText?: boolean;
}

export const SHORTCUTS: readonly Shortcut[] = [
  {
    action: "palette",
    label: "Command palette",
    chord: { key: "k", mod: true },
    scope: "app",
    inText: true,
  },
  {
    action: "newSideChat",
    label: "New side chat",
    chord: { key: "n", mod: true },
    scope: "app",
    inText: true,
  },
  {
    action: "closeThreadView",
    label: "Close thread view or pop-out",
    chord: { key: "w", mod: true },
    scope: "app",
    inText: true,
  },
  {
    action: "toggleThreadList",
    label: "Toggle thread list",
    chord: { key: "b", mod: true },
    scope: "app",
    inText: true,
  },
  {
    action: "cycleThreads",
    label: "Cycle threads",
    chord: { key: "Tab", ctrl: true },
    scope: "app",
    inText: true,
  },
  {
    action: "forkSelection",
    label: "Fork selection into a side chat",
    chord: { key: ";", mod: true },
    scope: "app",
  },
  {
    action: "stop",
    label: "Stop the run; release Take control",
    chord: { key: "Escape" },
    scope: "app",
    inText: true,
  },
  {
    action: "cycleDisclosure",
    label: "Cycle disclosure: status, actions, raw",
    chord: { key: "o", ctrl: true },
    scope: "app",
    inText: true,
  },
  {
    action: "openBrowserPane",
    label: "Browser pane",
    chord: { key: "b", mod: true, shift: true },
    scope: "app",
    inText: true,
  },
  {
    action: "openDiffPane",
    label: "Diff pane",
    chord: { key: "d", mod: true, shift: true },
    scope: "app",
    inText: true,
  },
  {
    action: "toggleTerminalPane",
    label: "Terminal pane",
    chord: { key: "`", ctrl: true },
    scope: "app",
    inText: true,
  },
  {
    action: "permissionMode",
    label: "Permission mode",
    chord: { key: "m", mod: true, shift: true },
    scope: "app",
    inText: true,
  },
  {
    action: "modelPicker",
    label: "Model picker",
    chord: { key: "i", mod: true, shift: true },
    scope: "app",
    inText: true,
  },
  {
    action: "agentActivity",
    label: "Agent sheet: Activity",
    chord: { key: "a", mod: true, shift: true },
    scope: "app",
    inText: true,
  },
  {
    action: "agentApprovals",
    label: "Agent sheet: Approvals",
    chord: { key: "p", mod: true, shift: true },
    scope: "app",
    inText: true,
  },
  {
    action: "closePane",
    label: "Close focused pane",
    chord: { key: "\\", mod: true },
    scope: "app",
    inText: true,
  },
  {
    action: "shortcutList",
    label: "Shortcut list",
    chord: { key: "/", mod: true },
    scope: "app",
    inText: true,
  },
  {
    action: "approve",
    label: "Approve with selected scope; answer a question",
    chord: { key: "Enter", mod: true },
    scope: "app",
    inText: true,
  },
  {
    action: "deny",
    label: "Deny the focused approval",
    chord: { key: "d", mod: true },
    scope: "app",
  },
  {
    action: "quickEntry",
    label: "Quick entry",
    chord: { key: "Space", alt: true },
    scope: "global",
  },
  {
    action: "pushToTalk",
    label: "Push-to-talk dictation (hold)",
    chord: { key: "Fn" },
    scope: "global",
  },
];

export interface KeyEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function keyOf(e: KeyEventLike): string {
  // Shifted punctuation and Option-modified letters change `key`; fall back to the physical code.
  if (e.code === "Backquote") return "`";
  if (e.code === "Backslash") return "\\";
  if (e.code === "Slash") return "/";
  if (e.code === "Semicolon") return ";";
  if (e.code === "Space") return "Space";
  if (e.code?.startsWith("Key")) return e.code.slice(3).toLowerCase();
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

/** Finds the app-scope action for a key event. `mac` decides whether ⌘ or Ctrl is `mod`. */
export function matchShortcut(
  e: KeyEventLike,
  opts: { mac: boolean; inText?: boolean },
): ShortcutAction | null {
  const key = keyOf(e);
  for (const s of SHORTCUTS) {
    if (s.scope !== "app") continue;
    if (opts.inText && !s.inText) continue;
    const c = s.chord;
    const wantMeta = opts.mac ? Boolean(c.mod) : false;
    const wantCtrl = opts.mac ? Boolean(c.ctrl) : Boolean(c.mod) || Boolean(c.ctrl);
    if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl) continue;
    if (e.shiftKey !== Boolean(c.shift) || e.altKey !== Boolean(c.alt)) continue;
    if (key === (c.key.length === 1 ? c.key.toLowerCase() : c.key)) return s.action;
  }
  return null;
}

/** Human label for the shortcut sheet, e.g. "⌘⇧B" or "Ctrl+Shift+B". */
export function chordLabel(c: KeyChord, mac: boolean): string {
  const names: Record<string, string> = {
    Escape: "Esc",
    Enter: "Return",
    Space: "Space",
    Tab: "Tab",
  };
  const key = names[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
  if (mac)
    return `${c.ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.mod ? "⌘" : ""}${key}`;
  const parts = [c.mod || c.ctrl ? "Ctrl" : "", c.alt ? "Alt" : "", c.shift ? "Shift" : "", key];
  return parts.filter(Boolean).join("+");
}
