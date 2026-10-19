import { useEffect, useMemo, useState } from "react";
import { sniffMime } from "../core/detect.ts";
import type { ViewerProps } from "./contract.ts";
import { Toolbar, ViewerMessage } from "./states.tsx";
import { useLoadable } from "./useBytes.ts";

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml|heic)$/;

/** Object URL for bytes, revoked when the bytes change or the component unmounts. */
export function useObjectUrl(bytes: Uint8Array | undefined, mime: string): string | undefined {
  const url = useMemo(
    () =>
      bytes === undefined || typeof URL.createObjectURL !== "function"
        ? undefined
        : URL.createObjectURL(new Blob([bytes.slice()], { type: mime })),
    [bytes, mime],
  );
  useEffect(
    () => () => {
      if (url !== undefined) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

/**
 * Image viewer (P4). Always an `<img>` (SVG included: no scripts, no external loads), with fit,
 * actual size and zoom steps.
 */
export function ImageViewer(props: ViewerProps) {
  const state = useLoadable(props.item.id, (signal) => props.load(signal));
  const bytes = state.status === "ready" ? state.value : undefined;
  const mime = useMemo(() => {
    const sniffed = bytes === undefined ? undefined : sniffMime(bytes);
    const m = sniffed ?? props.item.mime;
    return IMAGE_TYPES.test(m) ? m : "application/octet-stream";
  }, [bytes, props.item.mime]);
  const url = useObjectUrl(bytes, mime);
  const [zoom, setZoom] = useState<number | "fit">(props.pageState?.zoom ?? "fit");
  if (state.status === "loading")
    return <ViewerMessage kind="loading" title={`Opening ${props.item.name}…`} />;
  if (state.status === "error")
    return (
      <ViewerMessage
        kind="error"
        title="This image could not be opened"
        detail={state.error.message}
      />
    );
  if (mime === "application/octet-stream")
    return <ViewerMessage kind="unsupported" title="This file is not a supported image" />;
  const set = (z: number | "fit") => {
    setZoom(z);
    if (z !== "fit") props.onPageStateChange?.({ zoom: z });
  };
  const current = zoom === "fit" ? 1 : zoom;
  return (
    <div className="psy-image">
      {props.compact ? null : (
        <Toolbar label="Image">
          <button type="button" aria-pressed={zoom === "fit"} onClick={() => set("fit")}>
            Fit
          </button>
          <button type="button" onClick={() => set(1)}>
            100%
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => set(Math.max(0.1, current / 1.25))}
          >
            −
          </button>
          <output aria-label="Zoom level">
            {zoom === "fit" ? "Fit" : `${Math.round(current * 100)}%`}
          </output>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => set(Math.min(8, current * 1.25))}
          >
            +
          </button>
          {props.onSendToChat ? (
            <button
              type="button"
              onClick={() => props.onSendToChat?.({ itemId: props.item.id, name: props.item.name })}
            >
              Send to chat
            </button>
          ) : null}
        </Toolbar>
      )}
      <div className="psy-image__stage" style={{ overflow: "auto" }}>
        {url === undefined ? null : (
          <img
            src={url}
            alt={props.item.name}
            draggable={false}
            style={
              zoom === "fit"
                ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }
                : { transform: `scale(${zoom})`, transformOrigin: "0 0" }
            }
          />
        )}
      </div>
    </div>
  );
}

/** Audio / video with native controls. */
export function MediaViewer(props: ViewerProps) {
  const state = useLoadable(props.item.id, (signal) => props.load(signal));
  const mime = /^(audio|video)\//.test(props.item.mime)
    ? props.item.mime
    : "application/octet-stream";
  const url = useObjectUrl(state.status === "ready" ? state.value : undefined, mime);
  if (state.status === "loading")
    return <ViewerMessage kind="loading" title={`Opening ${props.item.name}…`} />;
  if (state.status === "error")
    return (
      <ViewerMessage
        kind="error"
        title="This file could not be opened"
        detail={state.error.message}
      />
    );
  if (url === undefined) return null;
  return props.item.mime.startsWith("audio/") ? (
    // biome-ignore lint/a11y/useMediaCaption: user files have no caption tracks.
    <audio className="psy-media" controls src={url} aria-label={props.item.name} />
  ) : (
    // biome-ignore lint/a11y/useMediaCaption: user files have no caption tracks.
    <video
      className="psy-media"
      controls
      src={url}
      aria-label={props.item.name}
      style={{ maxWidth: "100%" }}
    />
  );
}
