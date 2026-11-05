import {
  type DictationKey,
  defaultHoldKeys,
  MAC_DICTATION_KEYS,
  WINDOWS_DICTATION_KEYS,
  windowsHoldKey,
} from "@psyche/protocol";
import { useStoreState } from "../data/provider.tsx";
import { t } from "../i18n/core.ts";
import { isWindows } from "../lib/platform.ts";

/**
 * Hold-to-talk keys for Settings → Voice & dictation, the composer and onboarding, in the same
 * vocabulary as the desktop and the helpers (`@psyche/protocol` `DictationKey`). A Mac offers fn,
 * Right Option and Right Command. A PC has no Fn the OS sees, so Windows offers its own keys by
 * name, and reads a Mac name an older Settings stored as the key the Windows helper holds for it
 * (`fn`, `rightOption` → Right Alt; `rightCommand` → Right Ctrl).
 */

export type HoldKeyRole = "dictation" | "voice";

/** The keys Settings lists as choices; any other Windows key is picked with "Press a key". */
export const WINDOWS_TALK_CHOICES: readonly DictationKey[] = [
  "rightCtrl",
  "rightAlt",
  "capsLock",
  "scrollLock",
  "pause",
  "menu",
];

/** Keys a stored value may name here. */
export const holdKeysHere = (): readonly DictationKey[] =>
  isWindows() ? [...MAC_DICTATION_KEYS, ...WINDOWS_DICTATION_KEYS] : MAC_DICTATION_KEYS;

/** The key a stored value means here (Windows: its physical key); the default when unknown. */
export function effectiveHoldKey(raw: unknown, role: HoldKeyRole = "dictation"): DictationKey {
  const windows = isWindows();
  const known = holdKeysHere().find((k) => k === raw);
  const key = known ?? defaultHoldKeys(windows)[role];
  return windows ? windowsHoldKey(key) : key;
}

/** The choices Settings offers for a hold-to-talk key. */
export const talkKeyChoices = (): readonly DictationKey[] =>
  isWindows() ? WINDOWS_TALK_CHOICES : MAC_DICTATION_KEYS;

/** A key as printed on this keyboard: "Right Ctrl", "Caps Lock", "F13", "fn", "Right Command". */
export function holdKeyLabel(key: DictationKey): string {
  const k = isWindows() ? windowsHoldKey(key) : key;
  if (/^f(1[3-9]|2[0-4])$/.test(k)) return k.toUpperCase();
  return t(`settings.voice.key.${k as Exclude<DictationKey, `f${number}`>}`);
}

/**
 * The hold-to-talk key a captured key event names (`KeyboardEvent.code`), for "Press a key" on
 * Windows; undefined for a key that types text or cannot be held to talk.
 */
export function holdKeyFromCode(code: string): DictationKey | undefined {
  const fn = /^F(1[3-9]|2[0-4])$/.exec(code);
  if (fn) return `f${fn[1]}` as DictationKey;
  const byCode: Record<string, DictationKey> = {
    ControlRight: "rightCtrl",
    AltRight: "rightAlt",
    ShiftRight: "rightShift",
    MetaRight: "rightWin",
    OSRight: "rightWin",
    CapsLock: "capsLock",
    ScrollLock: "scrollLock",
    Pause: "pause",
    ContextMenu: "menu",
    Insert: "insert",
    NumLock: "numLock",
  };
  return byCode[code];
}

/**
 * The dictation key's label from the settings the app already loaded (the composer's "Dictate
 * (hold …)"); the default key until they arrive. Never loads settings itself.
 */
export function useDictationKeyLabel(): string {
  const stored = useStoreState((s) => s.settings["voice.pushToTalk"]);
  return holdKeyLabel(effectiveHoldKey(stored, "dictation"));
}
