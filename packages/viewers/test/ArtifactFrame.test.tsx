// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_TAG } from "../src/core/artifact.ts";
import { ArtifactFrame } from "../src/react/ArtifactFrame.tsx";
import { EmailViewer } from "../src/react/EmailViewer.tsx";
import { MALICIOUS_EML } from "./fixtures/email.ts";

afterEach(cleanup);

const channelOf = (frame: HTMLIFrameElement) =>
  /var C="([0-9a-f]+)"/.exec(frame.getAttribute("srcdoc") ?? "")?.[1] ?? "";

function post(
  frame: HTMLIFrameElement,
  data: unknown,
  opts: { origin?: string; source?: unknown } = {},
) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        origin: opts.origin ?? "null",
        source: (opts.source ?? frame.contentWindow) as Window,
      }),
    );
  });
}

describe("ArtifactFrame", () => {
  it("renders a sandboxed srcdoc frame with CSP and no same-origin", () => {
    render(<ArtifactFrame title="Dash" html="<h1>Hi</h1>" />);
    const frame = screen.getByTitle("Dash") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("resizes only on valid messages from its own frame", () => {
    render(<ArtifactFrame title="Dash" html="<p>x</p>" maxHeight={900} />);
    const frame = screen.getByTitle("Dash") as HTMLIFrameElement;
    const ch = channelOf(frame);
    post(frame, { tag: BRIDGE_TAG, channel: ch, type: "resize", height: 640 });
    expect(frame.style.height).toBe("640px");
    post(frame, { tag: BRIDGE_TAG, channel: ch, type: "resize", height: 99999 });
    expect(frame.style.height).toBe("900px");
    // Wrong source, origin or channel: ignored.
    post(frame, { tag: BRIDGE_TAG, channel: ch, type: "resize", height: 50 }, { source: window });
    post(
      frame,
      { tag: BRIDGE_TAG, channel: ch, type: "resize", height: 50 },
      { origin: "https://evil.example" },
    );
    post(frame, { tag: BRIDGE_TAG, channel: "other", type: "resize", height: 50 });
    expect(frame.style.height).toBe("900px");
  });

  it("routes link clicks to the browser pane and drops unsafe schemes", () => {
    const onOpenLink = vi.fn();
    render(
      <ArtifactFrame
        title="Dash"
        html="<a href='https://x.example'>x</a>"
        onOpenLink={onOpenLink}
      />,
    );
    const frame = screen.getByTitle("Dash") as HTMLIFrameElement;
    const ch = channelOf(frame);
    post(frame, { tag: BRIDGE_TAG, channel: ch, type: "open-link", href: "javascript:alert(1)" });
    post(frame, { tag: BRIDGE_TAG, channel: ch, type: "open-link", href: "https://x.example/" });
    expect(onOpenLink).toHaveBeenCalledTimes(1);
    expect(onOpenLink).toHaveBeenCalledWith("https://x.example/");
  });

  it("tears the frame down when it navigates itself, and updates in place by version", () => {
    const onBlocked = vi.fn();
    const { rerender } = render(
      <ArtifactFrame title="Dash" html="<p>v1</p>" version={1} onBlockedNavigation={onBlocked} />,
    );
    let frame = screen.getByTitle("Dash") as HTMLIFrameElement;
    fireEvent.load(frame);
    fireEvent.load(frame);
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toMatch(/navigate away/);
    rerender(
      <ArtifactFrame title="Dash" html="<p>v2</p>" version={2} onBlockedNavigation={onBlocked} />,
    );
    frame = screen.getByTitle("Dash") as HTMLIFrameElement;
    expect(frame.getAttribute("srcdoc")).toContain("<p>v2</p>");
  });

  it("uses a cross-origin host page in hosted mode and answers host-ready with the document", () => {
    render(
      <ArtifactFrame title="Dash" html="<p>hosted</p>" hostUrl="http://127.0.0.1:7790/frame" />,
    );
    const frame = screen.getByTitle("Dash") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("http://127.0.0.1:7790/frame");
    const sent: unknown[] = [];
    Object.defineProperty(frame, "contentWindow", {
      value: { postMessage: (m: unknown, o: string) => sent.push([m, o]) },
    });
    post(frame, { tag: BRIDGE_TAG, type: "host-ready" }, { origin: "http://127.0.0.1:7790" });
    expect(sent).toHaveLength(1);
    const [msg, origin] = sent[0] as [{ type: string; srcdoc: string }, string];
    expect(origin).toBe("http://127.0.0.1:7790");
    expect(msg.srcdoc).toContain("<p>hosted</p>");
    // host-ready from another origin is ignored.
    post(frame, { tag: BRIDGE_TAG, type: "host-ready" }, { origin: "http://127.0.0.1:9999" });
    expect(sent).toHaveLength(1);
  });
});

describe("EmailViewer", () => {
  it("shows headers, blocks remote images, lists attachments, and runs no scripts", async () => {
    const onSave = vi.fn();
    render(
      <EmailViewer
        item={{ id: "m", name: "m.eml", mime: "message/rfc822", provenance: "untrusted" }}
        load={async () => new TextEncoder().encode(MALICIOUS_EML)}
        onSaveToLibrary={onSave}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Your invoice ✓" })).toBeTruthy();
    expect(screen.getByText(/treated as untrusted/)).toBeTruthy();
    const frame = screen.getByTitle(/Message:/) as HTMLIFrameElement;
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toMatch(/script-src 'nonce-[0-9a-f]+'/);
    expect(srcdoc).not.toMatch(/\ssrc="https:\/\/tracker/);
    expect(srcdoc).not.toMatch(/<script>fetch/);
    expect(screen.getByText(/remote images? blocked/)).toBeTruthy();
    fireEvent.click(screen.getByText("Load remote images"));
    const after = (screen.getByTitle(/Message:/) as HTMLIFrameElement).getAttribute("srcdoc") ?? "";
    expect(after).toContain('src="https://tracker.example/pixel.gif?u=ada"');
    expect(after).toMatch(/img-src data: blob: https:/);
    fireEvent.click(screen.getByText("Save to Library"));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      name: "invoice.pdf",
      mime: "application/pdf",
    });
  });
});
