/**
 * Ask about my screen without a helper (docs/design/cross-platform-2026.md §4.3, "screenshot
 * only"): when no node offers `screen.context` (no Windows helper yet, the Mac helper not
 * running), the desktop takes the frame itself with Electron's `desktopCapturer` and hands it to
 * the Gateway's `screen.capture` as `frame`, so the rest (the untrusted Library item, the
 * thumbnail, expiry, `chat.send.screen`) is the same. There is no text context: the vision model
 * reads the pixels.
 *
 * - Window mode captures the display with the pointer (Electron cannot tell which window the
 *   owner was looking at); region mode crops the dragged box from its display.
 * - Psyche's own windows (the ask panel above all) are excluded the way the helpers exclude
 *   them: on Windows they are marked capture-excluded (`setContentProtection`, i.e.
 *   WDA_EXCLUDEFROMCAPTURE) only for the moment of the capture.
 * - Coordinates are DIPs (Electron's screen points); the frame is in physical pixels of that
 *   display (`scaleFactor`), downscaled to the requested maximum.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayLike {
  id: number;
  bounds: Rect;
  scaleFactor: number;
}

export interface CaptureParams {
  mode: "window" | "region";
  rect?: Rect;
  maxWidth?: number;
  maxHeight?: number;
}

/** What the Gateway's `screen.capture` takes as `frame` (`ScreenContextResult`). */
export interface ScreenFrame {
  image: string | null;
  width: number;
  height: number;
  context: null;
}

/** The default frame size (the helper's), inside the protocol's 2560 x 1600 ceiling. */
export const DEFAULT_MAX = { width: 1600, height: 1000 } as const;

/** The display a capture is taken from: the region's centre, else the pointer's. */
export function captureDisplay(
  params: CaptureParams,
  displays: readonly DisplayLike[],
  pointer: { x: number; y: number },
): DisplayLike | undefined {
  const at =
    params.mode === "region" && params.rect
      ? { x: params.rect.x + params.rect.width / 2, y: params.rect.y + params.rect.height / 2 }
      : pointer;
  const inside = displays.find(
    (d) =>
      at.x >= d.bounds.x &&
      at.x < d.bounds.x + d.bounds.width &&
      at.y >= d.bounds.y &&
      at.y < d.bounds.y + d.bounds.height,
  );
  return inside ?? displays[0];
}

/**
 * The crop, in the display frame's physical pixels: the region intersected with the display,
 * scaled by its DPI; the whole frame for window mode. Null when the region misses it.
 */
export function cropRect(
  params: CaptureParams,
  display: DisplayLike,
  frame: { width: number; height: number },
): Rect | null {
  if (params.mode !== "region" || !params.rect) {
    return { x: 0, y: 0, width: frame.width, height: frame.height };
  }
  const r = params.rect;
  const b = display.bounds;
  const sx = frame.width / b.width;
  const sy = frame.height / b.height;
  const left = Math.max(r.x, b.x);
  const top = Math.max(r.y, b.y);
  const right = Math.min(r.x + r.width, b.x + b.width);
  const bottom = Math.min(r.y + r.height, b.y + b.height);
  if (right - left < 1 || bottom - top < 1) return null;
  const x = Math.round((left - b.x) * sx);
  const y = Math.round((top - b.y) * sy);
  return {
    x,
    y,
    width: Math.max(1, Math.min(frame.width - x, Math.round((right - left) * sx))),
    height: Math.max(1, Math.min(frame.height - y, Math.round((bottom - top) * sy))),
  };
}

/** Fits `size` inside the maximum, keeping its aspect ratio; never upscales. */
export function fitWithin(
  size: { width: number; height: number },
  max: { width: number; height: number },
): { width: number; height: number } {
  const k = Math.min(1, max.width / size.width, max.height / size.height);
  return {
    width: Math.max(1, Math.round(size.width * k)),
    height: Math.max(1, Math.round(size.height * k)),
  };
}

/** The slice of a NativeImage used here. */
export interface ImageLike {
  getSize(): { width: number; height: number };
  isEmpty(): boolean;
  crop(rect: Rect): ImageLike;
  resize(o: { width: number; height: number; quality?: "good" | "better" | "best" }): ImageLike;
  toJPEG(quality: number): Buffer;
}

export interface CaptureDeps {
  displays: () => DisplayLike[];
  pointer: () => { x: number; y: number };
  /** `desktopCapturer.getSources({types: ["screen"], thumbnailSize})`, narrowed. */
  sources: (thumbnail: {
    width: number;
    height: number;
  }) => Promise<{ display_id: string; thumbnail: ImageLike }[]>;
  /**
   * Hides Psyche's windows from capture while `run` takes the frame (Windows: content
   * protection on, then back off).
   */
  excludeOwnWindows?: <T>(run: () => Promise<T>) => Promise<T>;
}

/** Takes the frame; an empty one (Screen Recording off on macOS) has `image: null`. */
export async function captureScreenFrame(
  params: CaptureParams,
  deps: CaptureDeps,
): Promise<ScreenFrame> {
  const displays = deps.displays();
  const display = captureDisplay(params, displays, deps.pointer());
  if (!display) return { image: null, width: 0, height: 0, context: null };
  const physical = {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  };
  const take = () => deps.sources(physical);
  const sources = await (deps.excludeOwnWindows ? deps.excludeOwnWindows(take) : take());
  const source =
    sources.find((s) => s.display_id === String(display.id)) ??
    (displays.length === 1 ? sources[0] : undefined);
  if (!source || source.thumbnail.isEmpty()) {
    return { image: null, width: 0, height: 0, context: null };
  }
  const shot = source.thumbnail;
  const crop = cropRect(params, display, shot.getSize());
  if (!crop) return { image: null, width: 0, height: 0, context: null };
  const cropped = params.mode === "region" ? shot.crop(crop) : shot;
  const size = fitWithin(cropped.getSize(), {
    width: params.maxWidth ?? DEFAULT_MAX.width,
    height: params.maxHeight ?? DEFAULT_MAX.height,
  });
  const out =
    size.width === cropped.getSize().width
      ? cropped
      : cropped.resize({ ...size, quality: "better" });
  return {
    image: out.toJPEG(80).toString("base64"),
    width: size.width,
    height: size.height,
    context: null,
  };
}

/** Whether a Gateway error means "nothing here can capture" (no helper offers `screen.context`). */
export function wantsFallback(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "unavailable";
}
