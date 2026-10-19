import { useEffect, useMemo, useRef, useState } from "react";
import {
  ARTIFACT_SANDBOX,
  type ArtifactPolicy,
  type BridgeMessage,
  buildArtifactSrcdoc,
  HOST_RENDER,
  parseBridgeMessage,
} from "../core/artifact.ts";

export interface ArtifactFrameProps {
  html: string;
  title: string;
  /** Changing the version (update-by-name) re-renders the frame in place. */
  version?: number;
  policy?: ArtifactPolicy;
  /**
   * Hosted placement: URL of the Gateway's artifact host page on a separate origin
   * (`artifactHostPage`). Omit for the inline srcdoc placement.
   */
  hostUrl?: string;
  minHeight?: number;
  maxHeight?: number;
  /** A link click inside the frame (http, https, mailto only); open it in the browser pane. */
  onOpenLink?: (href: string) => void;
  onError?: (message: string) => void;
  /** The frame tried to navigate itself away; it has been torn down. */
  onBlockedNavigation?: () => void;
}

const DEFAULT_POLICY: ArtifactPolicy = { allowScripts: true };
const LINK_INTERVAL_MS = 1000;

/**
 * Renders untrusted HTML in the artifact sandbox (P6). The iframe never gets
 * `allow-same-origin`; messages are accepted only from this frame's window, with the expected
 * origin and per-render channel. A second `load` (the frame navigating itself) tears it down.
 */
export function ArtifactFrame(props: ArtifactFrameProps) {
  const { html, policy = DEFAULT_POLICY, hostUrl, version } = props;
  // Rebuild (fresh channel and nonce) when the content, the policy or the version changes.
  const policyKey = JSON.stringify([
    policy.allowScripts,
    policy.allowRemoteImages === true,
    policy.libraryOrigins ?? [],
  ]);
  const renderKey = `${version ?? ""}|${policyKey}`;
  const built = useMemo(() => {
    const [allowScripts, allowRemoteImages, libraryOrigins] = JSON.parse(
      renderKey.slice(renderKey.indexOf("|") + 1),
    ) as [boolean, boolean, string[]];
    return buildArtifactSrcdoc(html, { allowScripts, allowRemoteImages, libraryOrigins });
  }, [html, renderKey]);
  const hostOrigin = useMemo(
    () => (hostUrl === undefined ? undefined : new URL(hostUrl).origin),
    [hostUrl],
  );
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(props.minHeight ?? 120);
  const [blocked, setBlocked] = useState(false);
  const callbacks = useRef(props);
  callbacks.current = props;
  const lastLink = useRef(0);
  const answeredHost = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per render of a new document.
  useEffect(() => setBlocked(false), [built]);

  useEffect(() => {
    const expectedOrigin = hostOrigin ?? "null";
    const onMessage = (e: MessageEvent) => {
      const frame = ref.current;
      if (frame === null || e.source !== frame.contentWindow) return;
      if (hostOrigin !== undefined && e.origin === hostOrigin && isHostReady(e.data)) {
        // Answer once per document: a relayed or replayed host-ready must not loop renders.
        if (answeredHost.current === built.channel) return;
        answeredHost.current = built.channel;
        frame.contentWindow?.postMessage(
          { type: HOST_RENDER, channel: built.channel, srcdoc: built.srcdoc },
          hostOrigin,
        );
        return;
      }
      const msg: BridgeMessage | undefined = parseBridgeMessage(e.data, e.origin, {
        origin: expectedOrigin,
        channel: built.channel,
      });
      if (msg === undefined) return;
      const cb = callbacks.current;
      if (msg.type === "resize") {
        const max = cb.maxHeight ?? 4000;
        setHeight(Math.min(max, Math.max(cb.minHeight ?? 40, msg.height)));
      } else if (msg.type === "open-link") {
        // Artifact script can forge this message, so only honour it while the user is
        // interacting with the frame (focus is inside it after a click), at most once a second.
        const now = Date.now();
        if (document.activeElement !== frame || now - lastLink.current < LINK_INTERVAL_MS) return;
        lastLink.current = now;
        cb.onOpenLink?.(msg.href);
      } else if (msg.type === "error") cb.onError?.(msg.message);
      else if (msg.type === "navigated") {
        setBlocked(true);
        cb.onBlockedNavigation?.();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [built, hostOrigin]);

  if (blocked) {
    return (
      <div className="psy-artifact psy-artifact--blocked" role="alert">
        <p>This artifact tried to navigate away and was stopped.</p>
        <button type="button" onClick={() => setBlocked(false)}>
          Reload artifact
        </button>
      </div>
    );
  }

  if (hostUrl !== undefined) {
    return (
      <iframe
        key={built.channel}
        ref={ref}
        className="psy-artifact"
        title={props.title}
        src={hostUrl}
        // Cross-origin host page: allow-same-origin keeps its real (empty) origin so its messages
        // can be origin-checked. The untrusted document lives in the host's inner frame, which is
        // sandboxed with allow-scripts only.
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        style={{ width: "100%", height, border: 0, display: "block" }}
      />
    );
  }

  return (
    <InlineFrame
      key={built.channel}
      frameRef={ref}
      title={props.title}
      srcdoc={built.srcdoc}
      height={height}
      onNavigated={() => {
        setBlocked(true);
        callbacks.current.onBlockedNavigation?.();
      }}
    />
  );
}

const isHostReady = (data: unknown) =>
  typeof data === "object" && data !== null && (data as { type?: unknown }).type === "host-ready";

function InlineFrame(props: {
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  title: string;
  srcdoc: string;
  height: number;
  onNavigated: () => void;
}) {
  const loads = useRef(0);
  return (
    <iframe
      ref={props.frameRef}
      className="psy-artifact"
      title={props.title}
      sandbox={ARTIFACT_SANDBOX}
      srcDoc={props.srcdoc}
      referrerPolicy="no-referrer"
      onLoad={() => {
        loads.current += 1;
        if (loads.current > 1) props.onNavigated();
      }}
      style={{ width: "100%", height: props.height, border: 0, display: "block" }}
    />
  );
}
