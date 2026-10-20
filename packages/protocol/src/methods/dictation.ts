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

/** Modifier keys the helper can watch for hold-to-talk (Electron cannot see fn or key-up). */
export const DictationKey = StringEnum(["fn", "rightOption", "rightCommand"], {
  $id: "DictationKey",
});
export type DictationKey = Static<typeof DictationKey>;

export const DictationInsertMethod = StringEnum(["ax", "typed"], {
  $id: "DictationInsertMethod",
});
export type DictationInsertMethod = Static<typeof DictationInsertMethod>;

/** Why the focused element cannot take dictated text. */
export const DictationRefusal = StringEnum(
  ["no_focus", "secure_field", "own_window", "not_editable", "focus_changed"],
  { $id: "DictationRefusal" },
);
export type DictationRefusal = Static<typeof DictationRefusal>;

/** The focused app and element, as the helper sees it. Never carries the field's contents. */
export const DictationTarget = Type.Object(
  {
    pid: Type.Integer({ minimum: 0 }),
    bundleId: Nullable(Type.String()),
    appName: Type.String(),
    role: Nullable(Type.String({ description: "AX role of the focused element, e.g. AXTextArea" })),
    insertable: Type.Boolean(),
    refusal: Type.Optional(DictationRefusal),
  },
  { $id: "DictationTarget" },
);
export type DictationTarget = Static<typeof DictationTarget>;

/** Streamed by the helper's `dictation.watch` and forwarded as the `dictation.key` event. */
export const DictationKeyPayload = Type.Object(
  {
    key: DictationKey,
    down: Type.Boolean(),
    at: Type.String({ description: "ISO time the helper saw the change" }),
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
    }),
    result: Type.Object({ watching: Type.Boolean() }),
    scope: "operator.write",
    description:
      "Desktop only: watches a hold-to-talk modifier on the Mac and sends dictation.key events to the caller until it disconnects or calls again.",
  }),
} as const;
