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

/** What `isAltGraphText` reads from a `KeyboardEvent`. */
export interface AltGraphEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
  getModifierState?: (key: string) => boolean;
}

/** The character a physical key types without modifiers on a US layout: `KeyB` → "b". */
function plainKeyOf(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return undefined;
}

/**
 * Whether a Ctrl+Alt key event is AltGr typing a character, not a shortcut. On Windows the right
 * Alt key of many layouts (German, Polish, Czech, French…) is AltGr, which the browser reports as
 * Ctrl+Alt (with the `AltGraph` modifier state), and Windows turns a held Ctrl+Alt into AltGr as
 * well: AltGr+B is "{" on a Czech keyboard, AltGr+ß "\" on a German one. Such an event types text
 * and must never fire Ctrl+Alt+B or Ctrl+\. A Ctrl+Alt chord whose key still is the plain key
 * (`b` for `KeyB`, no AltGr meaning on this layout) stays a shortcut. Never on macOS: Option
 * changes `key` there and ⌘ is the command key.
 */
export function isAltGraphText(e: AltGraphEventLike, platform: UiPlatform = uiPlatform()): boolean {
  if (platform === "macos" || !e.ctrlKey || !e.altKey || e.metaKey === true) return false;
  // Only keys that type something: AltGr+Esc or AltGr+Enter are not text.
  if (e.key !== "Dead" && [...e.key].length !== 1) return false;
  if (e.key === "Dead") return true;
  // The key's own character: nothing was typed (this layout has no AltGr meaning for the key, or
  // it was plain Ctrl+Alt), so it is the shortcut even when the AltGraph state is set.
  const plain = plainKeyOf(e.code);
  if (plain !== undefined && e.key.toLowerCase() === plain) return false;
  if (e.getModifierState?.("AltGraph") === true) return true;
  // Without the modifier state (an older engine, a synthesised event): a symbol other than the
  // key's own is AltGr's. A letter is not taken for one, so Ctrl+Alt+B on a Cyrillic or Greek
  // layout (key "и") still works as the shortcut.
  return !/\p{L}/u.test(e.key);
}
