import { useEffect, useRef } from "react";
import { t } from "../i18n/core.ts";

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
  /** Display form, e.g. "⌘K". */
  keys: string;
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
    keys: "⌘K",
    get label() {
      return t("shell.shortcut.palette");
    },
    psyche: true,
    match: (e, m) => mod(e, m) && !e.shiftKey && key(e, "k"),
  },
  {
    id: "newSideChat",
    keys: "⌘N",
    get label() {
      return t("shell.shortcut.newSideChat");
    },
    match: (e, m) => mod(e, m) && !e.shiftKey && key(e, "n"),
  },
  {
    id: "closeThread",
    keys: "⌘W",
    get label() {
      return t("shell.shortcut.closeThread");
    },
    match: (e, m) => mod(e, m) && !e.shiftKey && key(e, "w"),
  },
  {
    id: "toggleThreadList",
    keys: "⌘B",
    get label() {
      return t("shell.shortcut.toggleThreadList");
    },
    match: (e, m) => mod(e, m) && !e.shiftKey && !e.altKey && key(e, "b"),
  },
  {
    id: "compactSidebar",
    keys: "⌥⌘B",
    get label() {
      return t("shell.shortcut.compactSidebar");
    },
    psyche: true,
    // ⌥ changes `key` on macOS (⌥B is "∫"); match the physical key.
    match: (e, m) => mod(e, m) && !e.shiftKey && e.altKey && (e.code === "KeyB" || key(e, "b")),
  },
  {
    id: "cycleThreads",
    keys: "⌃Tab",
    get label() {
      return t("shell.shortcut.cycleThreads");
    },
    match: (e) => e.ctrlKey && e.key === "Tab",
  },
  {
    id: "forkSelection",
    keys: "⌘;",
    get label() {
      return t("shell.shortcut.forkSelection");
    },
    match: (e, m) => mod(e, m) && e.key === ";",
  },
  {
    id: "stop",
    keys: "Esc",
    get label() {
      return t("shell.shortcut.stop");
    },
    match: (e) => e.key === "Escape",
  },
  {
    id: "cycleDisclosure",
    keys: "⌃O",
    get label() {
      return t("shell.shortcut.cycleDisclosure");
    },
    match: (e) => e.ctrlKey && !e.metaKey && key(e, "o"),
  },
  {
    id: "browserPane",
    keys: "⌘⇧B",
    get label() {
      return t("shell.shortcut.browserPane");
    },
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "b"),
  },
  {
    id: "diffPane",
    keys: "⌘⇧D",
    get label() {
      return t("shell.shortcut.diffPane");
    },
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "d"),
  },
  {
    id: "terminalPane",
    keys: "⌃`",
    get label() {
      return t("shell.shortcut.terminalPane");
    },
    match: (e) => e.ctrlKey && e.key === "`",
  },
  {
    id: "permissionMode",
    keys: "⌘⇧M",
    get label() {
      return t("shell.shortcut.permissionMode");
    },
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "m"),
  },
  {
    id: "modelPicker",
    keys: "⌘⇧I",
    get label() {
      return t("shell.shortcut.modelPicker");
    },
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "i"),
  },
  {
    id: "activity",
    keys: "⌘⇧A",
    get label() {
      return t("shell.shortcut.activity");
    },
    psyche: true,
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "a"),
  },
  {
    id: "approvals",
    keys: "⌘⇧P",
    get label() {
      return t("shell.shortcut.approvals");
    },
    psyche: true,
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "p"),
  },
  {
    id: "closePane",
    keys: "⌘\\",
    get label() {
      return t("shell.shortcut.closePane");
    },
    match: (e, m) => mod(e, m) && e.key === "\\",
  },
  {
    id: "shortcutList",
    keys: "⌘/",
    get label() {
      return t("shell.shortcut.shortcutList");
    },
    match: (e, m) => mod(e, m) && e.key === "/",
  },
];

/** Keys handled inside cards rather than globally, listed in the shortcut sheet. */
export const CARD_SHORTCUTS: readonly { keys: string; label: string; psyche?: true }[] = [
  {
    keys: "1–9",
    get label() {
      return t("shell.shortcut.cardOption");
    },
  },
  {
    keys: "⌘Return",
    get label() {
      return t("shell.shortcut.cardApprove");
    },
  },
  {
    keys: "⌘D",
    get label() {
      return t("shell.shortcut.cardDeny");
    },
    psyche: true,
  },
  {
    keys: "⌥Space",
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

export const isMac = (): boolean =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

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
