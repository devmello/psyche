import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useThreads } from "../src/data/index.ts";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { IDS } from "../src/fixtures/index.ts";
import { SPACE_IDS, withSpaces } from "../src/fixtures/spaces.ts";
import { SpacePage } from "../src/spaces/SpacePage.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";
import { dataWidget, progressWidget, taintedWidget } from "../src/widgets/fixtures.ts";

/** Links, tracker order and offers on the Space page, against the MockGateway. */

function setup(ui: ReactElement, edit: (w: FixtureWorld) => void = withSpaces) {
  let gateway: MockGateway | undefined;
  const user = userEvent.setup();
  render(
    <StoryWorld
      edit={edit}
      onGateway={(g) => {
        gateway = g;
      }}
      slots={{ navigate: vi.fn() }}
    >
      {ui}
    </StoryWorld>,
  );
  const gw = () => {
    if (gateway === undefined) throw new Error("gateway not ready");
    return gateway;
  };
  const callsTo = (method: string) => gw().calls.filter((c) => c.method === method);
  return { callsTo, user };
}

function WithThreads({ children }: { children: ReactNode }): ReactElement {
  useThreads();
  return <>{children}</>;
}

const page = () => (
  <WithThreads>
    <SpacePage spaceId={SPACE_IDS.kitchen} onNavigate={() => {}} now={STORY_NOW} />
  </WithThreads>
);

describe("Space links", () => {
  it("adds a link with a title, and shows the Gateway's refusal in its own words", async () => {
    const { callsTo, user } = setup(page());
    await screen.findByRole("heading", { level: 1, name: "Kitchen remodel" });
    await user.click(screen.getByRole("button", { name: "Add link" }));
    const dialog = await screen.findByRole("dialog");

    await user.type(within(dialog).getByRole("textbox", { name: "Link" }), "city.example/plans");
    await user.click(within(dialog).getByRole("button", { name: "Add link" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("a URL link must start with http:// or https://");

    await user.clear(within(dialog).getByRole("textbox", { name: "Link" }));
    await user.type(
      within(dialog).getByRole("textbox", { name: "Link" }),
      "https://city.example/plans",
    );
    await user.type(within(dialog).getByRole("textbox", { name: "Title (optional)" }), "Plans");
    await user.click(within(dialog).getByRole("button", { name: "Add link" }));

    await waitFor(() =>
      expect(callsTo("spaces.links.add").at(-1)?.params).toEqual({
        spaceId: SPACE_IDS.kitchen,
        kind: "url",
        ref: "https://city.example/plans",
        label: "Plans",
      }),
    );
    expect(await screen.findByText("Plans")).toBeTruthy();
  });

  it("removes a link, and Undo adds it back", async () => {
    const { callsTo, user } = setup(page());
    await user.click(await screen.findByRole("button", { name: "Remove Permit portal" }));
    await waitFor(() => expect(callsTo("spaces.links.remove")).toHaveLength(1));
    expect(callsTo("spaces.links.remove")[0]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      linkId: "lnk_permit",
    });
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(callsTo("spaces.links.add").at(-1)?.params).toEqual({
        spaceId: SPACE_IDS.kitchen,
        kind: "url",
        ref: "https://city.example/permits",
        label: "Permit portal",
      }),
    );
  });
});

describe("Tracker order", () => {
  it("moves a tracker down and saves the whole new order", async () => {
    const { callsTo, user } = setup(page());
    const [first] = await screen.findAllByTestId("tracker");
    if (first === undefined) throw new Error("no tracker rendered");
    await user.click(within(first).getByRole("button", { name: /^Move .* down$/ }));
    await waitFor(() => expect(callsTo("spaces.trackers.reorder")).toHaveLength(1));
    expect(callsTo("spaces.trackers.reorder")[0]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      widgetIds: [taintedWidget.id, progressWidget.id],
    });
  });

  it("disables Move up on the first tracker and Move down on the last", async () => {
    setup(page());
    const [first, last] = await screen.findAllByTestId("tracker");
    if (first === undefined || last === undefined) throw new Error("two trackers expected");
    const up = within(first).getByRole("button", { name: /^Move .* up$/ }) as HTMLButtonElement;
    const down = within(last).getByRole("button", { name: /^Move .* down$/ }) as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    expect(down.disabled).toBe(true);
  });
});

describe("Offers after chats moved in", () => {
  const withOffers = (w: FixtureWorld) => {
    withSpaces(w);
    if (w.spaces === undefined) throw new Error("spaces fixture missing");
    w.spaces.offers = {
      [SPACE_IDS.kitchen]: {
        widgets: [
          {
            id: `widget:${dataWidget.id}`,
            widgetId: dataWidget.id,
            title: "Expenses",
            fromThreadId: IDS.threads.dentist,
          },
        ],
        rules: [
          {
            id: "rule:copy-sam",
            text: "Copy Sam on contractor mail.",
            fromThreadId: IDS.threads.lisbon,
            fromThreadTitle: "Lisbon trip",
          },
        ],
      },
    };
  };

  it("shows the offers, adds an instruction to the Space, and dismisses a widget offer", async () => {
    const { callsTo, user } = setup(page(), withOffers);
    const banner = await screen.findByTestId("space-offers");
    expect(within(banner).getByText("Pinned in a chat here: Expenses")).toBeTruthy();

    await user.click(within(banner).getByRole("button", { name: "Add to instructions" }));
    await waitFor(() => expect(callsTo("spaces.update").length).toBeGreaterThan(0));
    expect(callsTo("spaces.update").at(-1)?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      instructions:
        "Budget is $25,000. Copy Sam on contractor mail. Prefer matte finishes.\nCopy Sam on contractor mail.",
    });

    const widgetRow = within(banner).getByText("Pinned in a chat here: Expenses").closest("li");
    if (widgetRow === null) throw new Error("widget offer row missing");
    await user.click(within(widgetRow).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(callsTo("spaces.offers.dismiss")).toHaveLength(1));
    expect(callsTo("spaces.offers.dismiss")[0]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      offerId: `widget:${dataWidget.id}`,
    });
  });

  it("renders nothing when there are no offers", async () => {
    setup(page());
    await screen.findByRole("heading", { level: 1, name: "Kitchen remodel" });
    expect(screen.queryByTestId("space-offers")).toBeNull();
  });
});
