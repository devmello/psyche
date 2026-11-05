import {
  isWindows,
  type KeyChord,
  chordLabel as kitChordLabel,
  RAIL_ITEMS,
  type RailItem,
  t,
} from "@psyche/ui";

/**
 * Keyboard map (docs/06 §4.11, feature E10) as data, so the shortcut sheet (⌘/), the command
 * palette and the key handler share one source. `mod` is ⌘ on macOS and Ctrl elsewhere.
 */

/** ⌘1–⌘4 open a place (the sidebar's own order: Chat, Home, Library, Memory). */
export type GoAction = `go:${RailItem}`;

export type ShortcutAction =
  | GoAction
  | "palette"
  | "newSideChat"
  | "closeThreadView"
  | "toggleThreadList"
  | "toggleCompactSidebar"
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

export type { KeyChord };

export interface Shortcut {
  action: ShortcutAction;
  /** Localized: read it when rendering, not at import. */
  readonly label: string;
  readonly chord: KeyChord;
  /** `app`: handled in the window; `global`: registered by the desktop main process. */
  scope: "app" | "global";
  /** Fires even while typing in the composer or another text field. */
  inText?: boolean;
}

const BASE_SHORTCUTS: readonly Shortcut[] = [
  {
    action: "palette",
    get label() {
      return t("web.shortcut.palette");
    },
    chord: { key: "k", mod: true },
    scope: "app",
    inText: true,
  },
  {
    action: "newSideChat",
    get label() {
      return t("web.shortcut.newSideChat");
    },
    chord: { key: "n", mod: true },
    scope: "app",
    inText: true,
  },
  {
    action: "closeThreadView",
    get label() {
      return t("web.shortcut.closeThreadView");
    },
    chord: { key: "w", mod: true },
    scope: "app",
    inText: true,
  },
  {
    action: "toggleThreadList",
    get label() {
      return t("shell.shortcut.toggleThreadList");
    },
    chord: { key: "b", mod: true },
    scope: "app",
    inText: true,
  },
  {
    action: "toggleCompactSidebar",
    get label() {
      return t("shell.shortcut.compactSidebar");
    },
    chord: { key: "b", mod: true, alt: true },
    scope: "app",
    inText: true,
  },
  {
    action: "cycleThreads",
    get label() {
      return t("web.shortcut.cycleThreads");
    },
    chord: { key: "Tab", ctrl: true },
    scope: "app",
    inText: true,
  },
  {
    action: "forkSelection",
    get label() {
      return t("web.shortcut.forkSelection");
    },
    chord: { key: ";", mod: true },
    scope: "app",
  },
  {
    action: "stop",
    get label() {
      return t("web.shortcut.stop");
    },
    chord: { key: "Escape" },
    scope: "app",
    inText: true,
  },
  {
    action: "cycleDisclosure",
    get label() {
      return t("web.shortcut.cycleDisclosure");
    },
    chord: { key: "o", ctrl: true },
    scope: "app",
    inText: true,
  },
  {
    action: "openBrowserPane",
    get label() {
      return t("web.shortcut.openBrowserPane");
    },
    chord: { key: "b", mod: true, shift: true },
    scope: "app",
    inText: true,
  },
  {
    action: "openDiffPane",
    get label() {
      return t("web.shortcut.openDiffPane");
    },
    chord: { key: "d", mod: true, shift: true },
    scope: "app",
    inText: true,
  },
  {
    action: "toggleTerminalPane",
    get label() {
      return t("web.shortcut.toggleTerminalPane");
    },
    chord: { key: "`", ctrl: true },
    scope: "app",
    inText: true,
  },
  {
    action: "permissionMode",
    get label() {
      return t("web.shortcut.permissionMode");
    },
    chord: { key: "m", mod: true, shift: true },
    scope: "app",
    inText: true,
  },
  {
    action: "modelPicker",
    get label() {
      return t("web.shortcut.modelPicker");
    },
    chord: { key: "i", mod: true, shift: true },
    scope: "app",
    inText: true,
  },
  {
    action: "agentActivity",
    get label() {
      return t("web.shortcut.agentActivity");
    },
    chord: { key: "a", mod: true, shift: true },
    scope: "app",
    inText: true,
  },
  {
    action: "agentApprovals",
    get label() {
      return t("web.shortcut.agentApprovals");
    },
    chord: { key: "p", mod: true, shift: true },
    scope: "app",
    inText: true,
  },
  {
    action: "closePane",
    get label() {
      return t("web.shortcut.closePane");
    },
    chord: { key: "\\", mod: true },
    scope: "app",
    inText: true,
  },
  {
    action: "shortcutList",
    get label() {
      return t("web.shortcut.shortcutList");
    },
    chord: { key: "/", mod: true },
    scope: "app",
    inText: true,
  },
  {
    action: "approve",
    get label() {
      return t("web.shortcut.approve");
    },
    chord: { key: "Enter", mod: true },
    scope: "app",
    inText: true,
  },
  {
    action: "deny",
    get label() {
      return t("web.shortcut.deny");
    },
    chord: { key: "d", mod: true },
    scope: "app",
  },
  {
    action: "quickEntry",
    get label() {
      return t("web.shortcut.quickEntry");
    },
    // Alt+Space opens the window menu on Windows; the desktop registers Ctrl+Alt+Space there.
    get chord(): KeyChord {
      return isWindows() ? { key: "Space", ctrl: true, alt: true } : { key: "Space", alt: true };
    },
    scope: "global",
  },
  {
    action: "pushToTalk",
    get label() {
      return t("web.shortcut.pushToTalk");
    },
    // fn never reaches Windows: hold-to-talk is Right Alt there (the "fn" setting's Windows key).
    get chord(): KeyChord {
      return { key: isWindows() ? t("voice.key.rightOption") : "Fn" };
    },
    scope: "global",
  },
];

/** ⌘1…: one chord per destination that has a digit in `RAIL_ITEMS`. */
const GO_SHORTCUTS: readonly Shortcut[] = RAIL_ITEMS.flatMap((item) => {
  const digit = item.digit === undefined ? undefined : String(item.digit);
  return digit === undefined
    ? []
    : [
        {
          action: `go:${item.id}` as GoAction,
          get label() {
            return t("shell.palette.goTo", { label: item.label });
          },
          chord: { key: digit, mod: true },
          scope: "app" as const,
          inText: true,
        },
      ];
});

export const SHORTCUTS: readonly Shortcut[] = [...BASE_SHORTCUTS, ...GO_SHORTCUTS];

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

/** Human label for the shortcut sheet, e.g. "⇧⌘B" or "Ctrl+Shift+B" (the kit's `chordLabel`). */
export function chordLabel(c: KeyChord, mac: boolean): string {
  return kitChordLabel(c, mac ? "macos" : isWindows() ? "windows" : "other");
}
