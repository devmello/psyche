import type { SpaceDetail, Widget } from "@psyche/protocol";
import type { SpacesWorld } from "../data/mock-spaces.ts";
import { dataWidget, progressWidget, taintedWidget } from "../widgets/fixtures.ts";
import { ago, IDS } from "./ids.ts";
import type { FixtureWorld } from "./index.ts";

/** Spaces for stories and tests (docs/design/spaces-2026.md §7): four Spaces, one with trackers. */

export const SPACE_IDS = {
  kitchen: "spc_kitchen",
  jobs: "spc_jobs",
  math: "spc_math",
  secret: "spc_secret",
} as const;

const detail = (
  id: string,
  name: string,
  sort: number,
  over: Partial<SpaceDetail["space"]> = {},
  parts: Partial<SpaceDetail> = {},
): SpaceDetail => ({
  space: {
    id,
    name,
    description: null,
    icon: null,
    instructions: "",
    instructionsRev: 1,
    entityId: null,
    defaultPermissionMode: null,
    connectorScope: null,
    private: false,
    sort,
    archivedAt: null,
    createdFrom: "owner",
    createdAt: ago(60 * 24 * 30),
    updatedAt: ago(60),
    ...over,
  },
  folders: [],
  links: [],
  trackers: [],
  automationIds: [],
  goalIds: [],
  counts: { chats: 0, trackers: 0, due: 0 },
  lastActivityAt: null,
  ...parts,
});

/** A fixture widget under a title of its own, so two on one shelf do not share a label. */
const retitled = (w: Widget, title: string, fallbackText: string): Widget => ({
  ...w,
  spec: { ...w.spec, title, fallbackText },
});

export function spacesWorld(): SpacesWorld {
  return {
    spaces: [
      detail(
        SPACE_IDS.kitchen,
        "Kitchen remodel",
        1,
        {
          description: "Budget $25k, cc Sam on contractor mail.",
          instructions: "Budget is $25,000. Copy Sam on contractor mail. Prefer matte finishes.",
        },
        {
          folders: [
            {
              path: "~/Projects/Kitchen",
              real: "/Users/owner/Projects/Kitchen",
              mode: "rw",
              automationsWrite: false,
              addedAt: ago(60 * 24 * 10),
              addedByDevice: null,
            },
          ],
          links: [
            {
              id: "lnk_permit",
              kind: "url",
              ref: "https://city.example/permits",
              label: "Permit portal",
              labelProvenance: "owner",
              addedBy: "owner",
              createdAt: ago(60 * 24 * 9),
            },
          ],
          trackers: [
            {
              widgetId: progressWidget.id,
              position: 0,
              kind: "bound",
              staleAfterS: null,
              refreshedAt: ago(120),
              addedBy: "owner",
              createdAt: ago(60 * 24 * 8),
            },
            {
              widgetId: taintedWidget.id,
              position: 1,
              kind: "query",
              staleAfterS: 3600,
              refreshedAt: ago(10),
              addedBy: "template",
              createdAt: ago(60 * 24 * 8),
              taint: [{ sourceKind: "email", sender: "quotes@mendez.example" }],
            },
          ],
          automationIds: [IDS.automations.subscriptionAudit],
          lastActivityAt: ago(60 * 20),
        },
      ),
      detail(SPACE_IDS.jobs, "Job search", 2, {
        description: "Replies, digests and interview prep.",
      }),
      detail(SPACE_IDS.math, "MATH 21 (Fall 2026)", 3),
      detail(SPACE_IDS.secret, "Surprise party", 4, { private: true }),
    ],
    due: { [SPACE_IDS.kitchen]: 2, [SPACE_IDS.jobs]: 1 },
    previews: {
      [SPACE_IDS.kitchen]: [
        {
          kind: "instructions",
          text: "Budget is $25,000. Copy Sam on contractor mail. Prefer matte finishes.",
          chars: 70,
          cap: 4000,
        },
        { kind: "card", text: "Kitchen remodel · 2 chats · 2 trackers", chars: 38, cap: 600 },
      ],
    },
  };
}

/**
 * Puts the Spaces in a fixture world: the Dentist and Lisbon chats are in Kitchen remodel, the
 * two tracker widgets are on its shelf, and a third widget is free to add.
 */
export function withSpaces(world: FixtureWorld): void {
  world.spaces = spacesWorld();
  world.threads = world.threads.map((e) =>
    e.thread.id === IDS.threads.dentist || e.thread.id === IDS.threads.lisbon
      ? { ...e, thread: { ...e.thread, spaceId: SPACE_IDS.kitchen } }
      : e,
  );
  const have = new Set(world.widgets.map((w) => w.id));
  world.widgets = [
    ...world.widgets,
    ...[
      retitled(progressWidget, "Budget", "Budget: $18,400 of $25,000 (74%)."),
      dataWidget,
      retitled(taintedWidget, "Contractor quotes", "Contractor quotes: 3 of 5 received."),
    ]
      .filter((w) => !have.has(w.id))
      .map((w) => ({ ...w, spaceId: w.id === dataWidget.id ? null : SPACE_IDS.kitchen })),
  ];
}
