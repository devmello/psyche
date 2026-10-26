import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { defineMethod } from "./define.ts";

/**
 * `screen.*` Ask about my screen (docs/design/screen-ask-2026.md). The owner presses the ask
 * shortcut and the desktop calls `screen.capture` once: the Gateway forwards it to the local Mac
 * helper's `screen.context` capability (the frontmost window or a dragged box, plus app, window
 * title, selected text and browser URL through AX), stores the frame as an untrusted Library
 * item and returns a thumbnail. The capture rides on `chat.send.screen`; `screen.discard` drops
 * it, and an unsent one expires after `SCREEN_CAPTURE_TTL_MS`.
 *
 * Nothing is captured in the background: only the desktop shell may call these methods, and
 * `nodes.invoke` / agent tools can never reach `screen.context`. Everything a capture carries is
 * untrusted content, so a turn that uses it widens taint like a web fetch.
 */

/** An unsent capture is deleted this long after it was taken (spec §3.2). */
export const SCREEN_CAPTURE_TTL_MS = 10 * 60_000;
/** The longest selected text a capture carries (spec §3.1). */
export const SCREEN_SELECTED_TEXT_MAX = 4_000;

export const ScreenCaptureMode = StringEnum(["window", "region"], { $id: "ScreenCaptureMode" });
export type ScreenCaptureMode = Static<typeof ScreenCaptureMode>;

/** A box in global screen points (origin top-left of the main display), for region mode. */
export const ScreenRect = Type.Object(
  {
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Number({ minimum: 1 }),
    height: Type.Number({ minimum: 1 }),
  },
  { $id: "ScreenRect" },
);
export type ScreenRect = Static<typeof ScreenRect>;

/** Why a capture has no image (its text context may still be there). */
export const ScreenCaptureRefusal = StringEnum(
  ["app_excluded", "secure_field", "no_window", "permission_missing"],
  { $id: "ScreenCaptureRefusal" },
);
export type ScreenCaptureRefusal = Static<typeof ScreenCaptureRefusal>;

/** The cheap text context of what the owner was looking at. All of it is untrusted. */
export const ScreenContext = Type.Object(
  {
    appName: Type.String(),
    bundleId: Nullable(Type.String()),
    windowTitle: Nullable(Type.String()),
    selectedText: Nullable(Type.String({ maxLength: SCREEN_SELECTED_TEXT_MAX })),
    url: Nullable(Type.String({ description: "The focused browser window's URL" })),
  },
  { $id: "ScreenContext" },
);
export type ScreenContext = Static<typeof ScreenContext>;

/** How the image goes with the request (spec §3.3): by the relevance rule, always, or never. */
export const ScreenImageChoice = StringEnum(["auto", "pinned", "dropped"], {
  $id: "ScreenImageChoice",
});
export type ScreenImageChoice = Static<typeof ScreenImageChoice>;

/** `chat.send.screen`: the capture a message was asked about. */
export const ChatScreenRef = Type.Object(
  { captureId: Id, image: ScreenImageChoice },
  { $id: "ChatScreenRef" },
);
export type ChatScreenRef = Static<typeof ChatScreenRef>;

/** The helper's `screen.context` result: the frame (base64) and its text context. */
export const ScreenContextResult = Type.Object(
  {
    image: Nullable(Type.String({ contentEncoding: "base64", description: "JPEG" })),
    width: Type.Integer({ minimum: 0 }),
    height: Type.Integer({ minimum: 0 }),
    context: Nullable(ScreenContext),
    refusal: Type.Optional(ScreenCaptureRefusal),
  },
  { $id: "ScreenContextResult" },
);
export type ScreenContextResult = Static<typeof ScreenContextResult>;

/** The helper's `screen.context` params (also `screen.capture`'s). */
export const ScreenContextParams = Type.Object(
  {
    mode: ScreenCaptureMode,
    rect: Type.Optional(ScreenRect),
    maxWidth: Type.Optional(Type.Integer({ minimum: 320, maximum: 2560 })),
    maxHeight: Type.Optional(Type.Integer({ minimum: 240, maximum: 1600 })),
  },
  { $id: "ScreenContextParams" },
);
export type ScreenContextParams = Static<typeof ScreenContextParams>;

export const ScreenCapture = Type.Object(
  {
    captureId: Id,
    /** The stored frame; null when the capture has no image (see `refusal`). */
    libraryItemId: Nullable(Id),
    thumbnail: Nullable(Type.String({ description: "data: URL, at most 320 px wide" })),
    width: Type.Integer({ minimum: 0 }),
    height: Type.Integer({ minimum: 0 }),
    mode: ScreenCaptureMode,
    context: Nullable(ScreenContext),
    refusal: Type.Optional(ScreenCaptureRefusal),
    expiresAt: IsoDateTime,
  },
  { $id: "ScreenCapture" },
);
export type ScreenCapture = Static<typeof ScreenCapture>;

export const ScreenMethods = {
  "screen.capture": defineMethod({
    params: ScreenContextParams,
    result: ScreenCapture,
    scope: "operator.write",
    description:
      "Desktop only: captures the frontmost window (or a box) and its text context once, on the owner's ask shortcut; the frame is stored as an untrusted Library item that expires unless sent.",
  }),
  "screen.discard": defineMethod({
    params: Type.Object({ captureId: Id }),
    result: Type.Object({ discarded: Type.Boolean() }),
    scope: "operator.write",
    description: "Desktop only: deletes an unsent capture and its frame (✕, Esc).",
  }),
} as const;
