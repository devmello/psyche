import type { Artifact, ArtifactTableView, ArtifactVersion } from "@psyche/protocol";
import { FIXTURE_NOW, IDS } from "./ids.ts";

/** Canvas artifacts with history for stories and tests (chat-experience-2026 §4.2). */
export const CANVAS_IDS = { doc: "art_canvas_doc", table: "art_canvas_table" } as const;

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
  return {
    artifacts: [doc, table],
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
      [table.id]: {
        contents: [TABLE],
        views: [null],
        versions: [version(table.id, 1, "agent", "3 rows × 3 columns", 5)],
      },
    },
  };
}
