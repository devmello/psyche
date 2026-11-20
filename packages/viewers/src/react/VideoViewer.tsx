import { useMemo } from "react";
import { sniffMime } from "../core/detect.ts";
import type { ViewerProps } from "./contract.ts";
import { MediaViewer, useObjectUrl } from "./ImageViewer.tsx";
import { ViewerMessage } from "./states.tsx";
import { useLoadable } from "./useBytes.ts";

/** The video types the platform `<video>` element is asked to play: mp4, mov, webm and m4v. */
export const VIDEO_TYPES = /^video\/(mp4|quicktime|webm|x-m4v)$/;

/**
 * Video viewer. The platform `<video>` element with its own controls, never autoplaying (so
 * nothing starts with sound) and loading only metadata until the owner presses play. The bytes
 * come from the host's `load`, which reads the file through the Gateway's granted-folder path in
 * ranges (`files.read` offset and length), the same path the image viewer uses.
 */
export function VideoViewer(props: ViewerProps) {
  const state = useLoadable(props.item.id, (signal) => props.load(signal));
  const bytes = state.status === "ready" ? state.value : undefined;
  const mime = useMemo(() => {
    const sniffed = bytes === undefined ? undefined : sniffMime(bytes);
    const declared = props.item.mime.toLowerCase();
    // mp4 and m4v share a container: trust the file name's more specific type when the bytes say mp4.
    const m =
      sniffed === "video/mp4" && declared === "video/x-m4v" ? declared : (sniffed ?? declared);
    return VIDEO_TYPES.test(m) ? m : "application/octet-stream";
  }, [bytes, props.item.mime]);
  const url = useObjectUrl(bytes, mime);
  if (state.status === "loading")
    return <ViewerMessage kind="loading" title={`Opening ${props.item.name}…`} />;
  if (state.status === "error")
    return (
      <ViewerMessage
        kind="error"
        title="This video could not be opened"
        detail={state.error.message}
      />
    );
  if (mime === "application/octet-stream")
    return <ViewerMessage kind="unsupported" title="This file is not a supported video" />;
  return (
    <div className="psy-video">
      {url === undefined ? null : (
        // biome-ignore lint/a11y/useMediaCaption: user files have no caption tracks.
        <video
          className="psy-media"
          controls
          playsInline
          preload="metadata"
          src={url}
          aria-label={props.item.name}
          style={{ maxWidth: "100%" }}
        />
      )}
    </div>
  );
}

/** The `media` render kind: video gets the video viewer, audio keeps the plain player. */
export function PlayerViewer(props: ViewerProps) {
  return props.item.mime.toLowerCase().startsWith("video/") ? (
    <VideoViewer {...props} />
  ) : (
    <MediaViewer {...props} />
  );
}
