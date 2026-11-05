import { useEffect, useRef } from "react";
import { t } from "../i18n/core.ts";
import { keysLabel } from "../lib/keys.ts";
import { isMac, isWindows } from "../lib/platform.ts";

/**
 * The keyboard map (UI design §4.11), modelled on the Claude desktop shortcuts. `mod` is ⌘ on
 * macOS and Ctrl elsewhere; `ctrl` is always Control (⌃O, ⌃Tab, ⌃`).
 */
export type ShortcutId =
  | "palette"
  | "newSideChat"
  | "closeThread"
  | "toggleThreadList"
  | "compactSidebar"
  | "cycleThreads"
  | "forkSelection"
  | "stop"
  | "cycleDisclosure"
  | "browserPane"
  | "diffPane"
  | "terminalPane"
  | "permissionMode"
  | "modelPicker"
  | "activity"
  | "approvals"
  | "closePane"
  | "shortcutList";

export interface Shortcut {
  id: ShortcutId;
  /** Display form for this platform: "⌘K" on macOS, "Ctrl+K" elsewhere (`lib/keys.ts`). */
  readonly keys: string;
  label: string;
  match: (e: KeyboardEvent, mac: boolean) => boolean;
  /** † Psyche additions to Claude's map. */
  psyche?: boolean;
}

const mod = (e: KeyboardEvent, mac: boolean) =>
  mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
const key = (e: KeyboardEvent, k: string) => e.key.toLowerCase() === k;

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: "palette",
    get keys() {
      return keysLabel("Mod+K");
    },
    get label() {
      return t("shell.shortcut.palette");
    },
    psyche: true,
    match: (e, m) => mod(e, m) && !e.shiftKey && key(e, "k"),
  },
  {
    id: "newSideChat",
    get keys() {
      return keysLabel("Mod+N");
    },
    get label() {
      return t("shell.shortcut.newSideChat");
    },
    match: (e, m) => mod(e, m) && !e.shiftKey && key(e, "n"),
  },
  {
    id: "closeThread",
    get keys() {
      return keysLabel("Mod+W");
    },
    get label() {
      return t("shell.shortcut.closeThread");
    },
    match: (e, m) => mod(e, m) && !e.shiftKey && key(e, "w"),
  },
  {
    id: "toggleThreadList",
    get keys() {
      return keysLabel("Mod+B");
    },
    get label() {
      return t("shell.shortcut.toggleThreadList");
    },
    match: (e, m) => mod(e, m) && !e.shiftKey && !e.altKey && key(e, "b"),
  },
  {
    id: "compactSidebar",
    get keys() {
      return keysLabel("Alt+Mod+B");
    },
    get label() {
      return t("shell.shortcut.compactSidebar");
    },
    psyche: true,
    // ⌥ changes `key` on macOS (⌥B is "∫"); match the physical key.
    match: (e, m) => mod(e, m) && !e.shiftKey && e.altKey && (e.code === "KeyB" || key(e, "b")),
  },
  {
    id: "cycleThreads",
    get keys() {
      return keysLabel("Ctrl+Tab");
    },
    get label() {
      return t("shell.shortcut.cycleThreads");
    },
    match: (e) => e.ctrlKey && e.key === "Tab",
  },
  {
    id: "forkSelection",
    get keys() {
      return keysLabel("Mod+;");
    },
    get label() {
      return t("shell.shortcut.forkSelection");
    },
    match: (e, m) => mod(e, m) && e.key === ";",
  },
  {
    id: "stop",
    get keys() {
      return keysLabel("Escape");
    },
    get label() {
      return t("shell.shortcut.stop");
    },
    match: (e) => e.key === "Escape",
  },
  {
    id: "cycleDisclosure",
    get keys() {
      return keysLabel("Ctrl+O");
    },
    get label() {
      return t("shell.shortcut.cycleDisclosure");
    },
    match: (e) => e.ctrlKey && !e.metaKey && key(e, "o"),
  },
  {
    id: "browserPane",
    get keys() {
      return keysLabel("Mod+Shift+B");
    },
    get label() {
      return t("shell.shortcut.browserPane");
    },
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "b"),
  },
  {
    id: "diffPane",
    get keys() {
      return keysLabel("Mod+Shift+D");
    },
    get label() {
      return t("shell.shortcut.diffPane");
    },
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "d"),
  },
  {
    id: "terminalPane",
    get keys() {
      return keysLabel("Ctrl+`");
    },
    get label() {
      return t("shell.shortcut.terminalPane");
    },
    match: (e) => e.ctrlKey && e.key === "`",
  },
  {
    id: "permissionMode",
    get keys() {
      return keysLabel("Mod+Shift+M");
    },
    get label() {
      return t("shell.shortcut.permissionMode");
    },
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "m"),
  },
  {
    id: "modelPicker",
    get keys() {
      return keysLabel("Mod+Shift+I");
    },
    get label() {
      return t("shell.shortcut.modelPicker");
    },
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "i"),
  },
  {
    id: "activity",
    get keys() {
      return keysLabel("Mod+Shift+A");
    },
    get label() {
      return t("shell.shortcut.activity");
    },
    psyche: true,
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "a"),
  },
  {
    id: "approvals",
    get keys() {
      return keysLabel("Mod+Shift+P");
    },
    get label() {
      return t("shell.shortcut.approvals");
    },
    psyche: true,
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "p"),
  },
  {
    id: "closePane",
    get keys() {
      return keysLabel("Mod+\\");
    },
    get label() {
      return t("shell.shortcut.closePane");
    },
    match: (e, m) => mod(e, m) && e.key === "\\",
  },
  {
    id: "shortcutList",
    get keys() {
      return keysLabel("Mod+/");
    },
    get label() {
      return t("shell.shortcut.shortcutList");
    },
    match: (e, m) => mod(e, m) && e.key === "/",
  },
];

/** Keys handled inside cards rather than globally, listed in the shortcut sheet. */
export const CARD_SHORTCUTS: readonly {
  readonly keys: string;
  readonly label: string;
  psyche?: true;
}[] = [
  {
    keys: "1–9",
    get label() {
      return t("shell.shortcut.cardOption");
    },
  },
  {
    get keys() {
      return keysLabel("Mod+Enter");
    },
    get label() {
      return t("shell.shortcut.cardApprove");
    },
  },
  {
    get keys() {
      return keysLabel("Mod+D");
    },
    get label() {
      return t("shell.shortcut.cardDeny");
    },
    psyche: true,
  },
  {
    // Alt+Space opens the window menu on Windows, so quick entry defaults to Ctrl+Alt+Space there.
    get keys() {
      return keysLabel(isWindows() ? "Ctrl+Alt+Space" : "Alt+Space");
    },
    get label() {
      return t("shell.shortcut.quickEntry");
    },
    psyche: true,
  },
  {
    get keys() {
      return t("shell.shortcut.pushToTalkKeys");
    },
    get label() {
      return t("shell.shortcut.pushToTalk");
    },
    psyche: true,
  },
];

/** ⌘ is the command key: the platform module decides (`lib/platform.ts`). */
export { isMac };

/**
 * Binds the global shortcuts on `window`. Handlers that are absent are ignored. Esc is consumed
 * (stopPropagation) so page content cannot swallow it (architecture §6).
 */
export function useShortcuts(
  handlers: Partial<Record<ShortcutId, () => void>>,
  enabled = true,
): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const mac = isMac();
    const onKey = (e: KeyboardEvent) => {
      for (const s of SHORTCUTS) {
        const h = ref.current[s.id];
        if (h !== undefined && s.match(e, mac)) {
          e.preventDefault();
          if (s.id === "stop") e.stopPropagation();
          h();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [enabled]);
}
