import { ArtifactFrame } from "@psyche/viewers";
import type { ReactNode } from "react";

/**
 * An MCP App in the artifact sandbox (generative-ui-2026 P9). The same frame as an HTML artifact
 * from untrusted content: an opaque origin, `connect-src 'none'`, no remote images, no frames or
 * workers. The page's declared CSP and permissions are not applied, so it gets nothing it asks
 * for, and the frame's bridge carries only resize, links (honoured only while the owner is
 * interacting with it) and errors: no message reaches a tool, a connector or the Gateway.
 */
export function renderMcpApp({ html, title }: { html: string; title: string }): ReactNode {
  return (
    <ArtifactFrame
      html={html}
      title={title}
      policy={{ allowScripts: true }}
      minHeight={160}
      maxHeight={640}
    />
  );
}
