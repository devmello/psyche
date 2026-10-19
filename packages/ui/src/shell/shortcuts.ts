import { useEffect, useRef } from "react";

/**
 * The keyboard map (UI design §4.11), modelled on the Claude desktop shortcuts. `mod` is ⌘ on
 * macOS and Ctrl elsewhere; `ctrl` is always Control (⌃O, ⌃Tab, ⌃`).
 */
export type ShortcutId =
  | "palette"
  | "newSideChat"
  | "closeThread"
  | "toggleThreadList"
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
    label: "Command palette",
    psyche: true,
    match: (e, m) => mod(e, m) && !e.shiftKey && key(e, "k"),
  },
  {
    id: "newSideChat",
    keys: "⌘N",
    label: "New side chat",
    match: (e, m) => mod(e, m) && !e.shiftKey && key(e, "n"),
  },
  {
    id: "closeThread",
    keys: "⌘W",
    label: "Close thread view or pop-out",
    match: (e, m) => mod(e, m) && !e.shiftKey && key(e, "w"),
  },
  {
    id: "toggleThreadList",
    keys: "⌘B",
    label: "Toggle thread list",
    match: (e, m) => mod(e, m) && !e.shiftKey && key(e, "b"),
  },
  {
    id: "cycleThreads",
    keys: "⌃Tab",
    label: "Cycle threads",
    match: (e) => e.ctrlKey && e.key === "Tab",
  },
  {
    id: "forkSelection",
    keys: "⌘;",
    label: "Fork from selection into a side chat",
    match: (e, m) => mod(e, m) && e.key === ";",
  },
  {
    id: "stop",
    keys: "Esc",
    label: "Stop the run; release Take control",
    match: (e) => e.key === "Escape",
  },
  {
    id: "cycleDisclosure",
    keys: "⌃O",
    label: "Cycle disclosure level",
    match: (e) => e.ctrlKey && !e.metaKey && key(e, "o"),
  },
  {
    id: "browserPane",
    keys: "⌘⇧B",
    label: "Browser pane",
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "b"),
  },
  {
    id: "diffPane",
    keys: "⌘⇧D",
    label: "Diff pane",
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "d"),
  },
  {
    id: "terminalPane",
    keys: "⌃`",
    label: "Terminal pane",
    match: (e) => e.ctrlKey && e.key === "`",
  },
  {
    id: "permissionMode",
    keys: "⌘⇧M",
    label: "Permission mode",
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "m"),
  },
  {
    id: "modelPicker",
    keys: "⌘⇧I",
    label: "Model picker",
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "i"),
  },
  {
    id: "activity",
    keys: "⌘⇧A",
    label: "Agent sheet → Activity",
    psyche: true,
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "a"),
  },
  {
    id: "approvals",
    keys: "⌘⇧P",
    label: "Agent sheet → Approvals",
    psyche: true,
    match: (e, m) => mod(e, m) && e.shiftKey && key(e, "p"),
  },
  {
    id: "closePane",
    keys: "⌘\\",
    label: "Close focused pane",
    match: (e, m) => mod(e, m) && e.key === "\\",
  },
  {
    id: "shortcutList",
    keys: "⌘/",
    label: "Shortcut list",
    match: (e, m) => mod(e, m) && e.key === "/",
  },
];

/** Keys handled inside cards rather than globally, listed in the shortcut sheet. */
export const CARD_SHORTCUTS = [
  { keys: "1–9", label: "Select a menu or question option" },
  { keys: "⌘Return", label: "Approve with the selected scope; answer a question" },
  { keys: "⌘D", label: "Deny the focused approval", psyche: true },
  { keys: "⌥Space", label: "Quick entry (global)", psyche: true },
  { keys: "Hold fn", label: "Push-to-talk dictation", psyche: true },
] as const;

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
