import { ARTIFACT_SANDBOX, randomToken } from "../core/artifact.ts";
import { type ReactArtifactFiles, reactSandboxSetup } from "../core/react-artifact.ts";

export type ReactArtifactStatus = "loading" | "running" | "error";

export interface ReactArtifactHandle {
  /** Per-mount bridge channel (in the bundler URL's fragment). */
  channel: string;
  /** Recompiles in place (update-by-name with the same frame). */
  update(files: ReactArtifactFiles): void;
  destroy(): void;
}

export interface MountReactArtifactOptions {
  /** The self-hosted bundler's root URL on its own origin, e.g. `http://127.0.0.1:4318/`. */
  bundlerUrl: string;
  onStatus?: (status: ReactArtifactStatus) => void;
  onError?: (message: string) => void;
}

/**
 * Starts a Sandpack runtime client against the self-hosted bundler in `iframe`. The frame keeps
 * `sandbox="allow-scripts"` (never `allow-same-origin`), so the bundler document has an opaque
 * origin. The Sandpack client posts to the bundler's URL origin by default, which an opaque
 * origin never matches, so its target becomes `"*"`: messages still go only to this frame's
 * window, and what they carry (the artifact's own source) is no secret. Replies are accepted only
 * from this frame's window (the client checks `event.source`).
 */
export async function mountReactArtifact(
  iframe: HTMLIFrameElement,
  files: ReactArtifactFiles,
  opts: MountReactArtifactOptions,
): Promise<ReactArtifactHandle> {
  const setup = reactSandboxSetup(files);
  const { SandpackRuntime } = await import("@codesandbox/sandpack-client/clients/runtime");
  iframe.setAttribute("sandbox", ARTIFACT_SANDBOX);
  iframe.setAttribute("referrerpolicy", "no-referrer");
  const channel = randomToken();
  const base = new URL(opts.bundlerUrl);
  base.hash = `channel=${channel}`;
  // The client navigates the frame twice in one tick (`location.replace`, then `src`); the
  // first is cancelled, so the frame sees exactly one load and any later one is a navigation.
  const client = new SandpackRuntime(iframe, setup, {
    bundlerURL: base.href,
    showOpenInCodeSandbox: false,
    showErrorScreen: false,
    showLoadingScreen: false,
  });
  // See above: an opaque-origin frame only receives messages targeted at "*".
  (client.iframeProtocol as unknown as { origin: string }).origin = "*";
  opts.onStatus?.("loading");
  const off = client.listen((msg) => {
    const m = msg as { type: string; action?: string; message?: string; compilatonError?: boolean };
    if (m.type === "action" && m.action === "show-error") {
      opts.onStatus?.("error");
      opts.onError?.(String(m.message ?? "error").slice(0, 500));
    } else if (m.type === "done") {
      opts.onStatus?.(m.compilatonError === true ? "error" : "running");
    }
  });
  return {
    channel,
    update(next) {
      client.updateSandbox(reactSandboxSetup(next));
    },
    destroy() {
      off();
      client.destroy();
    },
  };
}
