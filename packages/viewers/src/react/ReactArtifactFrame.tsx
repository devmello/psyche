import { useEffect, useMemo, useRef, useState } from "react";
import { ARTIFACT_SANDBOX, parseBridgeMessage } from "../core/artifact.ts";
import { parseReactArtifact } from "../core/react-artifact.ts";
import {
  mountReactArtifact,
  type ReactArtifactHandle,
  type ReactArtifactStatus,
} from "./sandpack.ts";

export interface ReactArtifactFrameProps {
  /** The artifact source: one component, or `{"files": {...}}` (see `parseReactArtifact`). */
  source: string;
  title: string;
  /** The Gateway's self-hosted bundler (`@psyche/viewers/bundler`) on its own origin. */
  bundlerUrl: string;
  minHeight?: number;
  maxHeight?: number;
  onOpenLink?: (href: string) => void;
  onError?: (message: string) => void;
  onStatus?: (status: ReactArtifactStatus) => void;
  onBlockedNavigation?: () => void;
}

const LINK_INTERVAL_MS = 1000;

/**
 * A React artifact (P6): Sandpack client in the app, our offline bundler in a
 * `sandbox="allow-scripts"` frame on the bundler origin. Same guarantees as `ArtifactFrame`:
 * bridge messages only from this frame's window with the opaque origin and this mount's channel,
 * `open-link` only right after the user interacted, and any navigation after the bundler page
 * loaded tears the frame down.
 */
export function ReactArtifactFrame(props: ReactArtifactFrameProps) {
  const parsed = useMemo(() => {
    try {
      return { files: parseReactArtifact(props.source) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [props.source]);
  const ref = useRef<HTMLIFrameElement>(null);
  const handle = useRef<ReactArtifactHandle | null>(null);
  const [height, setHeight] = useState(props.minHeight ?? 160);
  const [blocked, setBlocked] = useState(false);
  const [generation, setGeneration] = useState(0);
  const callbacks = useRef(props);
  callbacks.current = props;
  const lastLink = useRef(0);
  const files = "files" in parsed ? parsed.files : undefined;

  // Mount once per frame generation; later source changes recompile in place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `files` updates go through update().
  useEffect(() => {
    const frame = ref.current;
    if (blocked || frame === null || files === undefined) return;
    let cancelled = false;
    let loads = 0;
    const onLoad = () => {
      // The first load is the bundler page; anything after it is the frame navigating itself.
      if (frame.getAttribute("src") === null) return;
      loads += 1;
      if (loads > 1) {
        setBlocked(true);
        callbacks.current.onBlockedNavigation?.();
      }
    };
    frame.addEventListener("load", onLoad);
    let channel = "";
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || channel === "") return;
      const msg = parseBridgeMessage(e.data, e.origin, { origin: "null", channel });
      if (msg === undefined) return;
      const cb = callbacks.current;
      if (msg.type === "resize") {
        setHeight(Math.min(cb.maxHeight ?? 4000, Math.max(cb.minHeight ?? 40, msg.height)));
      } else if (msg.type === "open-link") {
        const now = Date.now();
        if (document.activeElement !== frame || now - lastLink.current < LINK_INTERVAL_MS) return;
        lastLink.current = now;
        cb.onOpenLink?.(msg.href);
      } else if (msg.type === "error") cb.onError?.(msg.message);
    };
    window.addEventListener("message", onMessage);
    mountReactArtifact(frame, files, {
      bundlerUrl: props.bundlerUrl,
      onStatus: (s) => callbacks.current.onStatus?.(s),
      onError: (m) => callbacks.current.onError?.(m),
    }).then(
      (h) => {
        if (cancelled) {
          h.destroy();
          return;
        }
        channel = h.channel;
        handle.current = h;
      },
      (error: unknown) =>
        callbacks.current.onError?.(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      cancelled = true;
      frame.removeEventListener("load", onLoad);
      window.removeEventListener("message", onMessage);
      handle.current?.destroy();
      handle.current = null;
    };
  }, [props.bundlerUrl, generation, blocked, files === undefined]);

  useEffect(() => {
    if (files !== undefined) handle.current?.update(files);
  }, [files]);

  if ("error" in parsed) {
    return (
      <div className="psy-artifact psy-artifact--blocked" role="alert">
        <p>This React artifact cannot run: {parsed.error}</p>
      </div>
    );
  }
  if (blocked) {
    return (
      <div className="psy-artifact psy-artifact--blocked" role="alert">
        <p>This artifact tried to navigate away and was stopped.</p>
        <button
          type="button"
          onClick={() => {
            setBlocked(false);
            setGeneration((g) => g + 1);
          }}
        >
          Reload artifact
        </button>
      </div>
    );
  }
  return (
    <iframe
      key={generation}
      ref={ref}
      className="psy-artifact"
      title={props.title}
      sandbox={ARTIFACT_SANDBOX}
      referrerPolicy="no-referrer"
      style={{ width: "100%", height, border: 0, display: "block" }}
    />
  );
}
