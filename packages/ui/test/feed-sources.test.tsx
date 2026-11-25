import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { FeedScreen } from "../src/screens/feed/FeedScreen.tsx";
import {
  checkFeedAddress,
  hostLabel,
  readFeedSources,
  writeFeedSources,
} from "../src/screens/feed/feed-sources.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

const FEED = "https://example.com/feed.xml";
const OTHER = "https://news.example.org/rss";

function setup(
  ui: ReactElement,
  stored?: Record<string, unknown>,
  slots?: Record<string, unknown>,
) {
  let gateway: MockGateway | undefined;
  const user = userEvent.setup();
  render(
    <StoryWorld
      {...(stored
        ? {
            edit: (w: FixtureWorld) => {
              w.settings["feed.sources"] = stored;
            },
          }
        : {})}
      onGateway={(g) => {
        gateway = g;
      }}
      slots={{ navigate: vi.fn(), ...slots } as never}
    >
      {ui}
    </StoryWorld>,
  );
  const gw = () => {
    if (gateway === undefined) throw new Error("gateway not ready");
    return gateway;
  };
  const writes = () => gw().calls.filter((c) => c.method === "settings.set");
  return { user, gw, writes };
}

/** Opens the Sources sheet from the Feed header and waits for its list to load. */
async function openSources(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Today options" }));
  await user.click(await screen.findByRole("menuitem", { name: "Sources" }));
  return screen.findByRole("dialog", { name: "Feed sources" });
}

describe("Feed source addresses (pure)", () => {
  it("reads the setting with the Gateway's defaults and keeps unknown keys on write", () => {
    expect(readFeedSources(undefined)).toEqual({ rss: [], hackerNews: true, arxiv: true });
    expect(readFeedSources({ rss: [FEED, 7], arxiv: false })).toEqual({
      rss: [FEED],
      hackerNews: true,
      arxiv: false,
    });
    expect(
      writeFeedSources(
        { rss: [FEED], extra: "kept" },
        { rss: [FEED, OTHER], hackerNews: false, arxiv: true },
      ),
    ).toEqual({ rss: [FEED, OTHER], hackerNews: false, arxiv: true, extra: "kept" });
  });

  it("accepts only http and https addresses, trimmed, without duplicates", () => {
    expect(checkFeedAddress("  https://example.com/feed.xml  ", [])).toEqual({
      ok: true,
      url: "https://example.com/feed.xml",
    });
    expect(checkFeedAddress("   ", [])).toEqual({ ok: false, problem: "empty" });
    expect(checkFeedAddress("example.com/feed", [])).toEqual({ ok: false, problem: "invalid" });
    expect(checkFeedAddress("ftp://files.example.com/a.xml", [])).toEqual({
      ok: false,
      problem: "scheme",
    });
    expect(checkFeedAddress("javascript:alert(1)", [])).toEqual({
      ok: false,
      problem: "scheme",
    });
    expect(checkFeedAddress("https://EXAMPLE.com/feed.xml", [FEED])).toEqual({
      ok: false,
      problem: "duplicate",
    });
    // Editing a feed may keep its own address.
    expect(checkFeedAddress(FEED, [FEED], 0)).toEqual({ ok: true, url: FEED });
  });

  it("shows a host, and the address itself when it has none", () => {
    expect(hostLabel(FEED)).toBe("example.com");
    expect(hostLabel("javascript:alert(1)")).toBe("javascript:alert(1)");
  });
});

describe("the Feed sources sheet", () => {
  it("opens from the Feed header and lists the stored feeds with their kind and address", async () => {
    const { user } = setup(<FeedScreen />, { rss: [FEED, OTHER], hackerNews: true, arxiv: false });
    const sheet = await openSources(user);
    expect(within(sheet).getByText("example.com")).toBeTruthy();
    expect(within(sheet).getByText("news.example.org")).toBeTruthy();
    expect(within(sheet).getAllByText("RSS or Atom")).toHaveLength(2);
    expect(within(sheet).getByText(FEED)).toBeTruthy();
    expect(
      within(sheet).getByRole("switch", { name: "Hacker News" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(sheet).getByRole("switch", { name: "arXiv" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("shows an empty state with the built-in sources on by default", async () => {
    const { user } = setup(<FeedScreen />);
    const sheet = await openSources(user);
    expect(within(sheet).getByText("No feeds added yet.")).toBeTruthy();
    expect(
      within(sheet).getByRole("switch", { name: "Hacker News" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(sheet).getByRole("switch", { name: "arXiv" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("turns a built-in source off with one settings.set that keeps the feeds", async () => {
    const { user, writes } = setup(<FeedScreen />, { rss: [FEED] });
    const sheet = await openSources(user);
    await user.click(within(sheet).getByRole("switch", { name: "arXiv" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.params).toMatchObject({
      key: "feed.sources",
      value: { rss: [FEED], hackerNews: true, arxiv: false },
    });
  });

  it("adds a feed and clears the field", async () => {
    const { user, writes } = setup(<FeedScreen />, { rss: [FEED] });
    const sheet = await openSources(user);
    await user.type(within(sheet).getByRole("textbox", { name: "Feed address" }), OTHER);
    await user.click(within(sheet).getByRole("button", { name: "Add feed" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.params).toMatchObject({
      key: "feed.sources",
      value: { rss: [FEED, OTHER], hackerNews: true, arxiv: true },
    });
    await waitFor(() =>
      expect(
        (within(sheet).getByRole("textbox", { name: "Feed address" }) as HTMLInputElement).value,
      ).toBe(""),
    );
  });

  it("explains each address problem next to the field and writes nothing", async () => {
    const { user, writes } = setup(<FeedScreen />, { rss: [FEED] });
    const sheet = await openSources(user);
    const field = within(sheet).getByRole("textbox", { name: "Feed address" });
    const add = within(sheet).getByRole("button", { name: "Add feed" });

    await user.click(add);
    expect((await within(sheet).findByRole("alert")).textContent).toBe(
      "Enter the web address of the feed.",
    );

    await user.type(field, "example.com/feed");
    await user.click(add);
    expect((await within(sheet).findByRole("alert")).textContent).toBe(
      "That isn't a web address. Start it with https://.",
    );

    await user.clear(field);
    await user.type(field, "ftp://files.example.com/a.xml");
    await user.click(add);
    expect((await within(sheet).findByRole("alert")).textContent).toBe(
      "Only http:// and https:// addresses can be feeds.",
    );

    await user.clear(field);
    await user.type(field, "https://EXAMPLE.com/feed.xml");
    await user.click(add);
    expect((await within(sheet).findByRole("alert")).textContent).toBe(
      "This feed is already in the list.",
    );
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(writes()).toHaveLength(0);
  });

  it("edits an address in place and saves the list", async () => {
    const { user, writes } = setup(<FeedScreen />, { rss: [FEED, OTHER] });
    const sheet = await openSources(user);
    await user.click(within(sheet).getByRole("button", { name: "Edit example.com" }));
    const field = within(sheet).getByDisplayValue(FEED);
    await user.clear(field);
    await user.type(field, "https://example.com/atom.xml");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.params).toMatchObject({
      value: { rss: ["https://example.com/atom.xml", OTHER] },
    });
  });

  it("removes a feed only after confirmation", async () => {
    const { user, writes } = setup(<FeedScreen />, { rss: [FEED, OTHER] });
    const sheet = await openSources(user);

    await user.click(within(sheet).getByRole("button", { name: "Remove example.com" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Remove example.com?")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(writes()).toHaveLength(0);

    await user.click(within(sheet).getByRole("button", { name: "Remove example.com" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Remove feed",
      }),
    );
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.params).toMatchObject({ value: { rss: [OTHER] } });
  });

  it("opens an http or https feed through openExternal and never opens any other address", async () => {
    const openExternal = vi.fn(async () => {});
    const { user } = setup(
      <FeedScreen />,
      { rss: [FEED, "javascript:alert(1)"] },
      { openExternal },
    );
    const sheet = await openSources(user);
    await user.click(
      within(sheet).getByRole("button", { name: "Open example.com in your browser" }),
    );
    expect(openExternal).toHaveBeenCalledWith(FEED);
    expect(within(sheet).queryByRole("button", { name: /Open javascript/ })).toBeNull();
    expect(within(sheet).getByText(/not read/)).toBeTruthy();
  });

  it("says the Feed does not report fetch status yet", async () => {
    const { user } = setup(<FeedScreen />, { rss: [FEED] });
    const sheet = await openSources(user);
    expect(
      within(sheet).getByText(
        "The Feed doesn't show yet when a feed was last read or whether it failed.",
      ),
    ).toBeTruthy();
  });
});
