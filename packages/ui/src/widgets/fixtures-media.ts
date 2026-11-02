import type { Widget, WidgetSpec } from "@psyche/protocol";
import { progressWidget } from "./fixtures.ts";

/** A tiny generated PNG (96×48 gradient) for image stories and tests. */
export const SAMPLE_PNG_BASE64 =
  "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";

const widget = (id: string, spec: WidgetSpec, over: Partial<Widget> = {}): Widget => ({
  ...progressWidget,
  id,
  spec,
  taint: [],
  ...over,
});

const months = ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov"];

export const chartsSpec: WidgetSpec = {
  v: 1,
  title: "Spend and trend",
  fallbackText: "Spend by month, a 6 month trend and a sparkline.",
  root: {
    id: "root",
    type: "stack",
    gap: "md",
    children: [
      {
        id: "bars",
        type: "chart",
        label: "Spend by month",
        kind: "bar",
        unit: "USD",
        series: [
          {
            name: "Food",
            points: months.map((x, i) => ({ x, y: [320, 410, 380, 450, 520, 480][i] as number })),
          },
          {
            name: "Travel",
            points: months.map((x, i) => ({ x, y: [120, 900, 150, 60, 80, 300][i] as number })),
          },
        ],
      },
      {
        id: "line",
        type: "chart",
        label: "Weekly runs",
        kind: "line",
        series: [
          {
            name: "This year",
            points: months.map((x, i) => ({ x, y: [4, 6, 5, 9, 11, 10][i] as number })),
          },
          {
            name: "Last year",
            points: months.map((x, i) => ({ x, y: [2, 3, 4, 4, 6, 7][i] as number })),
          },
          { name: "Goal", points: months.map((x) => ({ x, y: 8 })) },
        ],
      },
      {
        id: "spark",
        type: "chart",
        label: "Steps",
        kind: "sparkline",
        series: [
          { name: "Steps", points: [3, 5, 4, 8, 6, 9, 12].map((y, i) => ({ x: `d${i + 1}`, y })) },
        ],
      },
    ],
  },
};

export const imagesSpec = (src: Record<string, string>): WidgetSpec => ({
  v: 1,
  title: "Photos",
  fallbackText: "One photo.",
  root: { id: "root", type: "image", alt: "A blue gradient test image", src },
});

export const chartsWidget = widget("wdg_charts", chartsSpec);
export const dataImageWidget = widget(
  "wdg_img_data",
  imagesSpec({ dataUrl: `data:image/png;base64,${SAMPLE_PNG_BASE64}` }),
);
export const remoteImageWidget = widget(
  "wdg_img_remote",
  imagesSpec({ url: "https://img.example/photo.png" }),
);
export const remoteImageTaintedWidget = widget(
  "wdg_img_remote_t",
  imagesSpec({ url: "https://img.example/photo.png" }),
  {
    taint: [{ sourceKind: "web", origin: "https://news.example.com" }],
  },
);
export const mapWidget = widget("wdg_map", {
  v: 1,
  title: "Coffee stops",
  fallbackText: "Two coffee shops.",
  root: {
    id: "root",
    type: "map",
    label: "Coffee stops",
    places: [
      {
        name: "Verve Coffee",
        address: "1540 Pacific Ave, Santa Cruz",
        lat: 36.9741,
        lng: -122.0264,
      },
      { name: "Cat & Cloud", address: "3 Soquel Ave" },
    ],
  },
});
