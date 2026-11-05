import { type Static, Type } from "@sinclair/typebox";
import { Nullable, StringEnum } from "../common.ts";
import { defineMethod } from "./define.ts";

/**
 * `dictation.*` system-wide dictation (features J9, Q2; owner S14 helper, S11 desktop, S17
 * speech). The desktop captures audio and streams it through `voice.*` like the composer, so the
 * engine and the custom vocabulary are the same; on release it asks the Gateway to insert the
 * final transcript into the app that had focus. The Gateway forwards these calls to the local
 * Mac helper's capabilities of the same names, which insert through the Accessibility API
 * (`kAXSelectedTextAttribute`, then the value) and fall back to unicode CGEvent typing.
 *
 * Text inserted into another app is keystrokes, not owner input to Psyche: it never reaches the
 * agent, a thread or memory. The helper refuses secure text fields and Psyche's own windows, and
 * collapses control characters (newlines included) to spaces so dictation never presses Return.
 * Only a desktop device may call these methods; agents and `nodes.invoke` cannot reach them.
 */

/** The Mac's hold-to-talk modifiers, the names the mac helper watches. */
export const MAC_DICTATION_KEYS = ["fn", "rightOption", "rightCommand"] as const;

/**
 * Keys only the Windows helper watches (a low-level keyboard hook), by name: Right Ctrl, Right
 * Alt (AltGr on many layouts), Right Shift, the right Windows key, Caps Lock (its lock state is
 * put back after a hold), Scroll Lock, Pause, the Menu (Application) key, Insert, Num Lock and
 * F13–F24. Stable wire names, like the Mac's; the mac helper refuses them.
 */
export const WINDOWS_DICTATION_KEYS = [
  "rightCtrl",
  "rightAlt",
  "rightShift",
  "rightWin",
  "capsLock",
  "scrollLock",
  "pause",
  "menu",
  "insert",
  "numLock",
  "f13",
  "f14",
  "f15",
  "f16",
  "f17",
  "f18",
  "f19",
  "f20",
  "f21",
  "f22",
  "f23",
  "f24",
] as const;

/**
 * Keys the helper can watch for hold-to-talk (Electron cannot see fn or key-up). The Mac names
 * work on Windows too, where a PC's Fn never arrives: `fn` and `rightOption` are Right Alt and
 * `rightCommand` is Right Ctrl. On Windows the insert goes through UI Automation (`ax`) or
 * SendInput unicode typing (`typed`).
 */
export const DictationKey = StringEnum([...MAC_DICTATION_KEYS, ...WINDOWS_DICTATION_KEYS], {
  $id: "DictationKey",
});
export type DictationKey = Static<typeof DictationKey>;

/**
 * The physical key a stored name means on Windows: a Mac name maps to the Windows key the
 * helper holds for it (`fn`, `rightOption` → `rightAlt`; `rightCommand` → `rightCtrl`).
 */
export function windowsHoldKey(key: DictationKey): (typeof WINDOWS_DICTATION_KEYS)[number] {
  if (key === "rightCommand") return "rightCtrl";
  if (key === "fn" || key === "rightOption") return "rightAlt";
  return key;
}

/**
 * The hold-to-talk defaults: fn (dictation) and Right ⌘ (voice) on a Mac. On Windows Right Ctrl
 * dictates: it is never AltGr, a bare press opens nothing, and it stays the same key when the
 * owner switches keyboard layouts per window. Voice then defaults to Right Alt.
 */
export function defaultHoldKeys(windows: boolean): {
  dictation: DictationKey;
  voice: DictationKey;
} {
  return windows
    ? { dictation: "rightCtrl", voice: "rightAlt" }
    : { dictation: "fn", voice: "rightCommand" };
}

export const DictationInsertMethod = StringEnum(["ax", "typed"], {
  $id: "DictationInsertMethod",
});
export type DictationInsertMethod = Static<typeof DictationInsertMethod>;

/**
 * Why the focused element cannot take dictated text. `elevated_target` (Windows): the focused app
 * runs as administrator and UIPI blocks a normal-integrity helper from typing into it;
 * `dictation.insert` then fails `forbidden` with that reason.
 */
export const DictationRefusal = StringEnum(
  ["no_focus", "secure_field", "own_window", "not_editable", "focus_changed", "elevated_target"],
  { $id: "DictationRefusal" },
);
export type DictationRefusal = Static<typeof DictationRefusal>;

/** The focused app and element, as the helper sees it. Never carries the field's contents. */
export const DictationTarget = Type.Object(
  {
    pid: Type.Integer({ minimum: 0 }),
    bundleId: Nullable(
      Type.String({
        description:
          "macOS bundle id; on Windows the package family name of a packaged app, else its lowercase executable",
      }),
    ),
    appName: Type.String(),
    role: Nullable(
      Type.String({
        description:
          "AX role of the focused element (AXTextArea); on Windows its UI Automation control type (Edit, Document, …)",
      }),
    ),
    insertable: Type.Boolean(),
    refusal: Type.Optional(DictationRefusal),
  },
  { $id: "DictationTarget" },
);
export type DictationTarget = Static<typeof DictationTarget>;

/** What a watched key does: system dictation, or talking to Psyche (voice conversation). */
export const DictationKeyRole = StringEnum(["dictation", "voice"], { $id: "DictationKeyRole" });
export type DictationKeyRole = Static<typeof DictationKeyRole>;

/** Streamed by the helper's `dictation.watch` and forwarded as the `dictation.key` event. */
export const DictationKeyPayload = Type.Object(
  {
    key: DictationKey,
    down: Type.Boolean(),
    at: Type.String({ description: "ISO time the helper saw the change" }),
    /** Set when the watch named roles (`keys`); absent for a single-key watch. */
    role: Type.Optional(DictationKeyRole),
  },
  { $id: "DictationKeyPayload" },
);
export type DictationKeyPayload = Static<typeof DictationKeyPayload>;

export const DictationMethods = {
  "dictation.target": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ target: Nullable(DictationTarget) }),
    scope: "operator.write",
    description:
      "Desktop only: the focused app and element on this Mac and whether dictated text can go there; null when nothing has focus.",
  }),
  "dictation.insert": defineMethod({
    params: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 4000 }),
      expectPid: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Refuse with focus_changed unless this process still has focus",
        }),
      ),
    }),
    result: Type.Object({
      method: DictationInsertMethod,
      chars: Type.Integer({ minimum: 0 }),
      target: DictationTarget,
    }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Desktop only: inserts dictated text into the focused element (AX, else CGEvent typing); refuses secure fields and Psyche's windows; the text never reaches the agent. Side-effecting: a duplicate would type the text twice.",
  }),
  "dictation.watch": defineMethod({
    params: Type.Object({
      key: Type.Union([DictationKey, Type.Null()], { description: "null stops watching" }),
      keys: Type.Optional(
        Type.Array(Type.Object({ key: DictationKey, role: DictationKeyRole }), {
          minItems: 1,
          maxItems: 2,
          description:
            "Watch up to two keys with roles (dictation, voice); takes precedence over key. Keys and roles must differ.",
        }),
      ),
    }),
    result: Type.Object({ watching: Type.Boolean() }),
    scope: "operator.write",
    description:
      "Desktop only: watches a hold-to-talk modifier on the Mac and sends dictation.key events to the caller until it disconnects or calls again.",
  }),
} as const;
