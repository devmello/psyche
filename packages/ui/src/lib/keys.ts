import { type UiPlatform, uiPlatform } from "./platform.ts";

/**
 * A key combination, platform-neutral: `mod` is ⌘ on macOS and Ctrl elsewhere; `ctrl` is always
 * Control (⌃O, ⌃Tab), which on Windows is the same key as `mod`.
 */
export interface KeyChord {
  /** `KeyboardEvent.key`-style: "k", "Enter", "Escape", "Space", "Tab", "/", "1"… */
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

const MAC_KEYS: Record<string, string> = {
  Enter: "Return",
  Return: "Return",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** Windows names keys by their keycaps, in words ("Enter", "Esc", "Up"). */
const TEXT_KEYS: Record<string, string> = {
  Enter: "Enter",
  Return: "Enter",
  Escape: "Esc",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

const keyCap = (key: string, mac: boolean): string =>
  (mac ? MAC_KEYS[key] : TEXT_KEYS[key]) ?? (key.length === 1 ? key.toUpperCase() : key);

/**
 * How a chord is written for the owner: "⌥⇧⌘B" on macOS (Apple's modifier order ⌃⌥⇧⌘), and
 * "Ctrl+Alt+Shift+B" on Windows and elsewhere, as text, never glyphs.
 */
export function chordLabel(c: KeyChord, platform: UiPlatform = uiPlatform()): string {
  const mac = platform === "macos";
  const key = keyCap(c.key, mac);
  if (mac)
    return `${c.ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.mod ? "⌘" : ""}${key}`;
  return [c.mod || c.ctrl ? "Ctrl" : "", c.alt ? "Alt" : "", c.shift ? "Shift" : "", key]
    .filter(Boolean)
    .join("+");
}

/**
 * Parses the kit's neutral chord notation ("Mod+Shift+B", "Ctrl+Tab", "Alt+Mod+B", "Mod+Enter")
 * into a chord. Modifier names are case-insensitive; the last part is the key.
 */
export function parseChord(spec: string): KeyChord {
  const parts = spec.split("+");
  // "Mod++" (the plus key) splits into a trailing empty part.
  const rawKey = parts.at(-1) === "" && parts.length > 1 ? "+" : (parts.at(-1) ?? "");
  const chord: KeyChord = { key: rawKey };
  for (const p of parts.slice(0, rawKey === "+" ? -2 : -1)) {
    const m = p.toLowerCase();
    if (m === "mod" || m === "cmd" || m === "command") chord.mod = true;
    else if (m === "shift") chord.shift = true;
    else if (m === "alt" || m === "option") chord.alt = true;
    else if (m === "ctrl" || m === "control") chord.ctrl = true;
  }
  return chord;
}

/** `chordLabel(parseChord(spec))`: "Mod+K" → "⌘K" / "Ctrl+K". */
export const keysLabel = (spec: string, platform: UiPlatform = uiPlatform()): string =>
  chordLabel(parseChord(spec), platform);

/** True when the event's command modifier is down: ⌘ on macOS, Ctrl elsewhere. */
export function modKey(
  e: { metaKey: boolean; ctrlKey: boolean },
  platform: UiPlatform = uiPlatform(),
): boolean {
  return platform === "macos" ? e.metaKey : e.ctrlKey;
}
