import { lazy, type ReactNode, Suspense } from "react";

// The sandbox frame loads with the first MCP App, not at startup.
const ArtifactFrame = lazy(async () => ({
  default: (await import("@psyche/viewers")).ArtifactFrame,
}));

/**
 * An MCP App in the artifact sandbox (generative-ui-2026 P9). The same frame as an HTML artifact
 * from untrusted content: an opaque origin, `connect-src 'none'`, no remote images, no frames or
 * workers. The page's declared CSP and permissions are not applied, so it gets nothing it asks
 * for. The frame's own bridge carries resize, links (honoured only while the owner is interacting
 * with it) and errors. The one other channel is the MCP Apps JSON-RPC bridge: `tools/call` for a
 * tool of the app's own connector, answered only to this frame's window, through the Gateway's
 * permission broker. Nothing else it posts reaches the Gateway.
 */
export function renderMcpApp({
  html,
  title,
  callTool,
}: {
  html: string;
  title: string;
  callTool?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ isError: boolean; output: unknown }>;
}): ReactNode {
  return (
    <Suspense fallback={null}>
      <ArtifactFrame
        html={html}
        title={title}
        policy={{ allowScripts: true }}
        minHeight={160}
        maxHeight={640}
        rpc={callTool === undefined ? {} : { callTool }}
      />
    </Suspense>
  );
}
