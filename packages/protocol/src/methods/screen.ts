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

/**
 * `screen.capture` params: the helper's, plus `frame`, a capture the desktop app took itself
 * (Electron `desktopCapturer`) for when no Host helper offers `screen.context` (Windows without the
 * helper: the screenshot-only fallback, cross-platform design §4.3). Used only then, and only from
 * the Psyche desktop shell on the Host; a helper's own capture always wins.
 */
export const ScreenCaptureParams = Type.Object(
  {
    ...ScreenContextParams.properties,
    frame: Type.Optional(ScreenContextResult),
  },
  { $id: "ScreenCaptureParams" },
);
export type ScreenCaptureParams = Static<typeof ScreenCaptureParams>;

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
    params: ScreenCaptureParams,
    result: ScreenCapture,
    scope: "operator.write",
    description:
      "Desktop only: captures the frontmost window (or a box) and its text context once, on the owner's ask shortcut; the frame is stored as an untrusted Library item that expires unless sent. Without a Host helper offering screen.context, the desktop shell may pass its own capture as frame (JPEG, screenshot only).",
  }),
  "screen.discard": defineMethod({
    params: Type.Object({ captureId: Id }),
    result: Type.Object({ discarded: Type.Boolean() }),
    scope: "operator.write",
    description: "Desktop only: deletes an unsent capture and its frame (✕, Esc).",
  }),
} as const;

/**
 * `vscreen.*` (linux design §7, §11): the Linux helper's virtual-screen capabilities, an Xvfb
 * display the helper manages on the owner's machine. These are node capabilities, not Gateway
 * methods, so they are not in `Methods`: the shapes below are the helper's `NodeCapability`
 * inputs and results. Host-only: `nodes.invoke` reaches only `vscreen.status`; the Gateway's own
 * virtual-screen module and the watch view call the rest through the Permission Broker.
 */
export const VSCREEN_CAPABILITIES = [
  "vscreen.start",
  "vscreen.stop",
  "vscreen.status",
  "vscreen.frame",
  "vscreen.input",
] as const;
export type VscreenCapability = (typeof VSCREEN_CAPABILITIES)[number];

/** The only `vscreen.*` capability `nodes.invoke` may reach. */
export const VSCREEN_NODES_INVOKE_ALLOWED = ["vscreen.status"] as const;

export const VscreenState = StringEnum(["stopped", "starting", "running", "stopping"], {
  $id: "VscreenState",
});
export type VscreenState = Static<typeof VscreenState>;

export const VscreenApp = Type.Object(
  {
    /** The desktop file id (`org.gnome.TextEditor`, `firefox`). */
    appId: Type.String({ minLength: 1, maxLength: 200 }),
    pid: Type.Integer({ minimum: 1 }),
    windowTitle: Nullable(Type.String({ maxLength: 500 })),
    /** The app shows a "Save changes?" dialog, so it was not closed (spec §7.4). */
    hasUnsavedChanges: Type.Optional(Type.Boolean()),
  },
  { $id: "VscreenApp" },
);
export type VscreenApp = Static<typeof VscreenApp>;

export const VscreenStatus = Type.Object(
  {
    state: VscreenState,
    /** The X display (`:90`), null when stopped. */
    display: Nullable(Type.String()),
    width: Type.Integer({ minimum: 0 }),
    height: Type.Integer({ minimum: 0 }),
    apps: Type.Array(VscreenApp),
    /** The owner is driving through the watch view; the agent is paused. */
    takenOver: Type.Boolean(),
    /** Changes whenever the screen does; pass it as `vscreen.frame.since`. */
    frameSeq: Type.Integer({ minimum: 0 }),
    startedAt: Nullable(IsoDateTime),
  },
  { $id: "VscreenStatus" },
);
export type VscreenStatus = Static<typeof VscreenStatus>;

export const VscreenStartParams = Type.Object(
  {
    width: Type.Optional(Type.Integer({ minimum: 640, maximum: 3840 })),
    height: Type.Optional(Type.Integer({ minimum: 480, maximum: 2160 })),
  },
  { $id: "VscreenStartParams" },
);
export type VscreenStartParams = Static<typeof VscreenStartParams>;

export const VscreenStopParams = Type.Object(
  {
    /** Close every app (a "Save changes?" dialog parks the Task) before stopping. Default true. */
    closeApps: Type.Optional(Type.Boolean()),
  },
  { $id: "VscreenStopParams" },
);
export type VscreenStopParams = Static<typeof VscreenStopParams>;

export const VscreenFrameParams = Type.Object(
  {
    /** The `frameSeq` the caller already has: the frame is returned only when it changed. */
    since: Type.Optional(Type.Integer({ minimum: 0 })),
    maxWidth: Type.Optional(Type.Integer({ minimum: 160, maximum: 3840 })),
  },
  { $id: "VscreenFrameParams" },
);
export type VscreenFrameParams = Static<typeof VscreenFrameParams>;

export const VscreenFrame = Type.Object(
  {
    /** False when nothing changed since `since`; `image` is then null. */
    changed: Type.Boolean(),
    frameSeq: Type.Integer({ minimum: 0 }),
    image: Nullable(Type.String({ contentEncoding: "base64", description: "JPEG" })),
    width: Type.Integer({ minimum: 0 }),
    height: Type.Integer({ minimum: 0 }),
  },
  { $id: "VscreenFrame" },
);
export type VscreenFrame = Static<typeof VscreenFrame>;

/** The watch view's take-over: the owner's own clicks and keys, forwarded through XTest. */
export const VscreenInputEvent = Type.Union(
  [
    Type.Object({
      type: StringEnum(["move", "down", "up"]),
      x: Type.Number(),
      y: Type.Number(),
      button: Type.Optional(StringEnum(["left", "middle", "right"])),
    }),
    Type.Object({
      type: Type.Literal("scroll"),
      x: Type.Number(),
      y: Type.Number(),
      dx: Type.Number(),
      dy: Type.Number(),
    }),
    Type.Object({
      type: StringEnum(["key_down", "key_up"]),
      /** A DOM `KeyboardEvent.key` value. */
      key: Type.String({ minLength: 1, maxLength: 32 }),
    }),
    Type.Object({ type: Type.Literal("text"), text: Type.String({ maxLength: 1000 }) }),
  ],
  { $id: "VscreenInputEvent" },
);
export type VscreenInputEvent = Static<typeof VscreenInputEvent>;

export const VscreenInputParams = Type.Object(
  { events: Type.Array(VscreenInputEvent, { maxItems: 100 }) },
  { $id: "VscreenInputParams" },
);
export type VscreenInputParams = Static<typeof VscreenInputParams>;

export const VscreenAck = Type.Object({ ok: Type.Boolean() }, { $id: "VscreenAck" });
export type VscreenAck = Static<typeof VscreenAck>;
