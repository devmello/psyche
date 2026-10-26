import type { Artifact, ArtifactTableView, ArtifactVersion } from "@psyche/protocol";
import { FIXTURE_NOW, IDS } from "./ids.ts";

/** Canvas artifacts with history for stories and tests (chat-experience-2026 §4.2). */
export const CANVAS_IDS = {
  doc: "art_canvas_doc",
  table: "art_canvas_table",
  chart: "art_canvas_chart",
  diff: "art_canvas_diff",
  map: "art_canvas_map",
  html: "art_canvas_html",
  htmlUntrusted: "art_canvas_html_untrusted",
} as const;

const DOC_V1 = "# Lisbon, 3 days\n\n## Day 1\n- Alfama walk\n- Dinner in Bairro Alto\n";
const DOC_V2 = `${DOC_V1}\n## Day 2\n- Belém and the tower\n`;
const DOC_V3 = DOC_V2.replace("- Alfama walk", "- Alfama walk, tram 28 back");
const TABLE = JSON.stringify({
  columns: ["Item", "Owner", "Cost"],
  rows: [
    ["Flights", "Jane", 412],
    ["Hotel", "You", 690],
    ["Tram passes", "You", 24],
  ],
});

const CHART = JSON.stringify({
  kind: "bar",
  title: "Trip cost by item",
  yLabel: "EUR",
  categories: ["Flights", "Hotel", "Tram passes", "Food"],
  series: [
    { name: "Planned", values: [400, 700, 30, 220] },
    { name: "Actual", values: [412, 690, 24, 260] },
  ],
});
export const MAP_FIXTURE = JSON.stringify({
  title: "Lisbon, day 1",
  markers: [
    {
      id: "a",
      lat: 38.711,
      lng: -9.13,
      label: "Alfama viewpoint",
      note: "Miradouro de Santa Luzia",
      link: "https://www.visitlisboa.com/",
    },
    { id: "b", lat: 38.7139, lng: -9.1334, label: "Time Out Market", note: "Lunch" },
    { id: "c", lat: 38.7223, lng: -9.1393, label: "Bairro Alto dinner" },
    { id: "d", lat: 38.6916, lng: -9.216, label: "Belém Tower" },
  ],
  routes: [
    {
      label: "Walk",
      points: [
        [38.711, -9.13],
        [38.7139, -9.1334],
        [38.7223, -9.1393],
      ],
    },
  ],
});
const DIFF = `--- a/itinerary.md
+++ b/itinerary.md
@@ -1,4 +1,5 @@
 # Lisbon, 3 days
-- Alfama walk
+- Alfama walk, tram 28 back
+- Pastéis in Belém
 - Dinner in Bairro Alto
`;

const HTML = '<h1>Packing list</h1><button onclick="alert(1)">Open</button>';

const at = (min: number) => new Date(Date.parse(FIXTURE_NOW) - min * 60_000).toISOString();

function version(
  artifactId: string,
  n: number,
  author: ArtifactVersion["author"],
  summary: string,
  minutesAgo: number,
): ArtifactVersion {
  return {
    artifactId,
    version: n,
    author,
    kind: n === 1 ? "snapshot" : "ops",
    bytes: 0,
    hash: `fx${n}`,
    summary,
    runId: null,
    toolCallId: null,
    createdAt: at(minutesAgo),
  };
}

export function canvasFixtures(): {
  artifacts: Artifact[];
  artifactHistory: Record<
    string,
    { contents: string[]; views: (ArtifactTableView | null)[]; versions: ArtifactVersion[] }
  >;
} {
  const doc: Artifact = {
    id: CANVAS_IDS.doc,
    libraryItemId: "lib_canvas_doc",
    type: "doc",
    title: "Lisbon itinerary",
    version: 3,
    nameSlug: "lisbon-itinerary",
    sourceRef: null,
    updatedAt: at(2),
    threadId: IDS.threads.lisbon,
    bytes: DOC_V3.length,
  };
  const table: Artifact = {
    id: CANVAS_IDS.table,
    libraryItemId: "lib_canvas_table",
    type: "table",
    title: "Trip budget",
    version: 1,
    nameSlug: "trip-budget",
    sourceRef: null,
    updatedAt: at(5),
    threadId: IDS.threads.lisbon,
    bytes: TABLE.length,
  };
  const chart: Artifact = {
    id: CANVAS_IDS.chart,
    libraryItemId: "lib_canvas_chart",
    type: "chart",
    title: "Trip cost chart",
    version: 1,
    nameSlug: "trip-cost-chart",
    sourceRef: null,
    updatedAt: at(8),
    threadId: IDS.threads.lisbon,
    bytes: CHART.length,
  };
  const map: Artifact = {
    id: CANVAS_IDS.map,
    libraryItemId: "lib_canvas_map",
    type: "map",
    title: "Lisbon, day 1",
    version: 1,
    nameSlug: "lisbon-day-1",
    sourceRef: null,
    updatedAt: at(13),
    threadId: IDS.threads.lisbon,
    bytes: MAP_FIXTURE.length,
  };
  const diff: Artifact = {
    id: CANVAS_IDS.diff,
    libraryItemId: "lib_canvas_diff",
    type: "diff",
    title: "Itinerary changes",
    version: 1,
    nameSlug: "itinerary-changes",
    sourceRef: null,
    updatedAt: at(9),
    threadId: IDS.threads.lisbon,
    bytes: DIFF.length,
  };
  const html: Artifact = {
    id: CANVAS_IDS.html,
    libraryItemId: "lib_canvas_html",
    type: "html",
    title: "Packing page",
    version: 1,
    nameSlug: "packing-page",
    sourceRef: null,
    updatedAt: at(11),
    threadId: IDS.threads.lisbon,
    bytes: HTML.length,
  };
  const htmlUntrusted: Artifact = {
    ...html,
    id: CANVAS_IDS.htmlUntrusted,
    title: "Page from an email",
    updatedAt: at(12),
    untrusted: true,
  };
  return {
    artifacts: [doc, table, chart, diff, html, htmlUntrusted, map],
    artifactHistory: {
      [doc.id]: {
        contents: [DOC_V1, DOC_V2, DOC_V3],
        views: [null, null, null],
        versions: [
          version(doc.id, 1, "agent", "6 lines", 20),
          version(doc.id, 2, "agent", "1 insert (+3 lines); 9 lines", 12),
          version(doc.id, 3, "user", "1 replace (+0 lines); 9 lines", 2),
        ],
      },
      [chart.id]: {
        contents: [CHART],
        views: [null],
        versions: [version(chart.id, 1, "agent", "bar chart, 2 series × 4 points", 8)],
      },
      [map.id]: {
        contents: [MAP_FIXTURE],
        views: [null],
        versions: [version(map.id, 1, "agent", "map, 4 markers", 8)],
      },
      [diff.id]: {
        contents: [DIFF],
        views: [null],
        versions: [version(diff.id, 1, "specialist", "4 lines", 9)],
      },
      [html.id]: {
        contents: [HTML],
        views: [null],
        versions: [version(html.id, 1, "agent", "1 lines", 11)],
      },
      [htmlUntrusted.id]: {
        contents: [HTML],
        views: [null],
        versions: [version(htmlUntrusted.id, 1, "agent", "1 lines", 12)],
      },
      [table.id]: {
        contents: [TABLE],
        views: [null],
        versions: [version(table.id, 1, "agent", "3 rows × 3 columns", 5)],
      },
    },
  };
}
