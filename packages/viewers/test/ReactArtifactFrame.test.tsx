// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_TAG } from "../src/core/artifact.ts";

const mounts: {
  iframe: HTMLIFrameElement;
  files: Record<string, string>;
  bundlerUrl: string;
  updates: Record<string, string>[];
  destroyed: boolean;
  onError?: (m: string) => void;
}[] = [];

vi.mock("../src/react/sandpack.ts", () => ({
  mountReactArtifact: vi.fn(async (iframe, files, opts) => {
    const m = {
      iframe,
      files,
      bundlerUrl: opts.bundlerUrl,
      updates: [],
      destroyed: false,
      onError: opts.onError,
    };
    mounts.push(m);
    return {
      channel: `chan${mounts.length}`,
      update: (f: Record<string, string>) => m.updates.push(f),
      destroy: () => {
        m.destroyed = true;
      },
    };
  }),
}));

const { ReactArtifactFrame } = await import("../src/react/ReactArtifactFrame.tsx");

afterEach(() => {
  cleanup();
  mounts.length = 0;
});

function post(
  frame: HTMLIFrameElement,
  data: unknown,
  source: Window | null = frame.contentWindow,
) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data, origin: "null", source: source as Window }),
    );
  });
}

const bundlerUrl = "http://127.0.0.1:4318/";

describe("ReactArtifactFrame", () => {
  it("mounts in an allow-scripts frame and honours only its own bridge messages", async () => {
    const onError = vi.fn();
    render(
      <ReactArtifactFrame
        title="dash"
        source="export default () => <p/>"
        bundlerUrl={bundlerUrl}
        onError={onError}
      />,
    );
    await waitFor(() => expect(mounts).toHaveLength(1));
    const frame = screen.getByTitle("dash") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(mounts[0]?.files).toEqual({ "/App.tsx": "export default () => <p/>" });
    expect(mounts[0]?.bundlerUrl).toBe(bundlerUrl);
    await act(async () => {});

    post(frame, { tag: BRIDGE_TAG, channel: "chan1", type: "resize", height: 640 });
    expect(frame.style.height).toBe("640px");
    // Wrong channel, wrong source: ignored.
    post(frame, { tag: BRIDGE_TAG, channel: "other", type: "resize", height: 900 });
    post(frame, { tag: BRIDGE_TAG, channel: "chan1", type: "resize", height: 900 }, window);
    expect(frame.style.height).toBe("640px");
    post(frame, { tag: BRIDGE_TAG, channel: "chan1", type: "error", message: "boom" });
    expect(onError).toHaveBeenCalledWith("boom");
  });

  it("recompiles in place when the source changes", async () => {
    const { rerender } = render(
      <ReactArtifactFrame title="a" source="export default () => 1" bundlerUrl={bundlerUrl} />,
    );
    await waitFor(() => expect(mounts).toHaveLength(1));
    await act(async () => {});
    rerender(
      <ReactArtifactFrame title="a" source="export default () => 2" bundlerUrl={bundlerUrl} />,
    );
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.updates).toEqual([{ "/App.tsx": "export default () => 2" }]);
  });

  it("tears the frame down when it navigates after the bundler page loaded, and can reload", async () => {
    const onBlocked = vi.fn();
    render(
      <ReactArtifactFrame
        title="nav"
        source="export default () => 1"
        bundlerUrl={bundlerUrl}
        onBlockedNavigation={onBlocked}
      />,
    );
    await waitFor(() => expect(mounts).toHaveLength(1));
    const frame = screen.getByTitle("nav") as HTMLIFrameElement;
    frame.setAttribute("src", bundlerUrl);
    fireEvent.load(frame);
    expect(onBlocked).not.toHaveBeenCalled();
    fireEvent.load(frame);
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toMatch(/navigate away/);
    expect(mounts[0]?.destroyed).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload artifact" }));
    await waitFor(() => expect(mounts).toHaveLength(2));
  });

  it("explains a source it cannot run instead of mounting", () => {
    render(
      <ReactArtifactFrame
        title="bad"
        source={JSON.stringify({ files: { "/util.ts": "" } })}
        bundlerUrl={bundlerUrl}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/cannot run/);
    expect(mounts).toHaveLength(0);
  });
});
