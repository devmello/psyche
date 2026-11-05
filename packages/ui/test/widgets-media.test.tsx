import type { Widget } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { IDS } from "../src/fixtures/index.ts";
import { StoryWorld } from "../src/stories/harness.tsx";
import {
  chartsWidget,
  dataImageWidget,
  imagesSpec,
  mapWidget,
  remoteImageTaintedWidget,
  remoteImageWidget,
} from "../src/widgets/fixtures-media.ts";
import { WidgetBlockView } from "../src/widgets/WidgetBlock.tsx";

function mount(widget: Widget, settings: Record<string, unknown> = {}) {
  const ref: { gateway?: MockGateway } = {};
  const calls: string[] = [];
  render(
    <StoryWorld
      edit={(w) => {
        w.widgets = [widget];
        Object.assign(w.settings, settings);
      }}
      onGateway={(g) => {
        ref.gateway = g;
        const original = g.request.bind(g);
        g.request = ((method: string, params: unknown, options: unknown) => {
          calls.push(method);
          return (original as (...a: unknown[]) => unknown)(method, params, options);
        }) as typeof g.request;
      }}
    >
      <WidgetBlockView block={{ type: "ui", widgetId: widget.id }} />
    </StoryWorld>,
  );
  return { ref, calls };
}

// The widget frame, its charts and images are lazy chunks. Load them once up front: under the
// full parallel suite their first transform took longer than findBy's 1 s, so the first test
// of each file timed out on the cold import rather than on anything it renders.
beforeAll(async () => {
  await Promise.all([
    import("../src/widgets/WidgetView.tsx"),
    import("../src/widgets/WidgetDraft.tsx"),
    import("../src/widgets/WidgetChart.tsx"),
    import("../src/widgets/WidgetImage.tsx"),
  ]);
}, 60_000);

describe("widget charts", () => {
  it("draws bar, line and sparkline with a spoken summary, legend and a data table alternative", async () => {
    mount(chartsWidget);
    const frame = await screen.findByTestId("widget");
    const imgs = await waitFor(() => {
      const found = within(frame).getAllByRole("img");
      expect(found.length).toBe(3);
      return found;
    });
    expect(imgs[0]?.getAttribute("aria-label")).toMatch(
      /Spend by month: bar chart, 2 series, 6 points, from Jun to Nov, lowest 60, highest 900 \(USD\)/,
    );
    expect(imgs[1]?.getAttribute("aria-label")).toMatch(/line chart, 3 series/);
    expect(imgs[2]?.getAttribute("aria-label")).toMatch(/sparkline, 1 series, 7 points/);
    expect(
      within(within(frame).getAllByRole("list", { name: "Series" })[1] as HTMLElement).getByText(
        "Goal",
      ),
    ).toBeTruthy(); // legend
    // The data is a real table even while closed (screen readers), and visible after Show data.
    const tables = within(frame).getAllByRole("table", { hidden: true });
    expect(tables.length).toBe(3);
    expect(tables[0]?.className).toContain("sr-only");
    await userEvent
      .setup()
      .click(within(frame).getAllByRole("button", { name: "Show data" })[0] as HTMLElement);
    expect(tables[0]?.className).not.toContain("sr-only");
    expect(
      within(tables[0] as HTMLElement)
        .getAllByRole("columnheader")
        .map((c) => c.textContent),
    ).toEqual(["Point", "Food", "Travel"]);
  });

  it("does not rely on colour alone: line series differ by dash pattern and marker shape", async () => {
    mount(chartsWidget);
    const frame = await screen.findByTestId("widget");
    await waitFor(() => expect(within(frame).getAllByRole("img").length).toBe(3));
    const line = within(frame).getAllByRole("img")[1] as Element;
    const dashes = [...line.querySelectorAll("path[stroke-dasharray]")].map((p) =>
      p.getAttribute("stroke-dasharray"),
    );
    expect(new Set(dashes).size).toBeGreaterThanOrEqual(2);
    expect(line.querySelector("circle")).toBeTruthy();
    expect(line.querySelector("rect")).toBeTruthy();
    expect(line.querySelector("polygon")).toBeTruthy();
  });

  it("draws nothing for a chart with no data instead of crashing", async () => {
    const empty: Widget = {
      ...chartsWidget,
      id: "wdg_empty",
      spec: {
        ...chartsWidget.spec,
        root: { id: "c", type: "chart", label: "x", kind: "bar", series: [] },
      },
    };
    mount(empty);
    expect(await screen.findByTestId("widget")).toBeTruthy();
    expect(screen.queryAllByRole("img")).toEqual([]);
  });
});

describe("widget images", () => {
  it("shows a data: image with alt text and no referrer", async () => {
    mount(dataImageWidget);
    const img = (await screen.findByRole("img", {
      name: "A blue gradient test image",
    })) as HTMLImageElement;
    expect(img.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("refuses an SVG or malformed data URL at render time", async () => {
    const svg = {
      ...dataImageWidget,
      id: "wdg_svg",
      spec: imagesSpec({ dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }),
    };
    mount(svg);
    expect(await screen.findByTestId("widget")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keeps remote images off by default and never asks the Gateway for them (D3)", async () => {
    const { calls } = mount(remoteImageWidget);
    expect(
      await screen.findByText(/Remote image not shown: A blue gradient test image/),
    ).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).not.toContain("widgets.image");
  });

  it("loads a remote image through the Gateway when the owner allows it", async () => {
    const { calls } = mount(remoteImageWidget, { "widgets.remoteImages": true });
    const img = (await screen.findByRole("img", {
      name: "A blue gradient test image",
    })) as HTMLImageElement;
    expect(img.src.startsWith("blob:")).toBe(true);
    expect(calls).toContain("widgets.image");
  });

  it("waits for a click in an untrusted widget before any request", async () => {
    const { calls } = mount(remoteImageTaintedWidget, { "widgets.remoteImages": true });
    const button = await screen.findByRole("button", { name: /untrusted content\. Load image/ });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).not.toContain("widgets.image");
    await userEvent.setup().click(button);
    expect(await screen.findByRole("img", { name: "A blue gradient test image" })).toBeTruthy();
    expect(calls).toContain("widgets.image");
  });

  it("draws a Library image by file id through files.read as a blob (the Library path)", async () => {
    const { calls } = mount({
      ...dataImageWidget,
      id: "wdg_file_ok",
      spec: imagesSpec({ fileId: IDS.library.avatar }),
    });
    const img = (await screen.findByRole("img", {
      name: "A blue gradient test image",
    })) as HTMLImageElement;
    expect(img.src.startsWith("blob:")).toBe(true);
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(calls).toContain("library.get");
    expect(calls).toContain("files.read");
  });

  it("refuses a Library file that is not an image type (e.g. SVG or text)", async () => {
    const { calls } = mount({
      ...dataImageWidget,
      id: "wdg_file_txt",
      spec: imagesSpec({ fileId: IDS.library.intakeForm }),
    });
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(calls).toContain("files.read");
  });

  it("reports a missing library file instead of drawing it", async () => {
    const w = { ...dataImageWidget, id: "wdg_file", spec: imagesSpec({ fileId: "lib_missing" }) };
    mount(w);
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
  });
});

describe("widget map (D4)", () => {
  it("is a place list with Open in Maps and no tiles, iframe or script", async () => {
    mount(mapWidget);
    const frame = await screen.findByTestId("widget");
    expect(within(frame).getByText("Verve Coffee")).toBeTruthy();
    const links = within(frame).getAllByRole("link", { name: "Open in Maps" });
    expect(links.length).toBe(2);
    expect(frame.querySelector("iframe, canvas, script, img")).toBeNull();
  });
});
