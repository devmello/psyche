import type { FeedPost } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ReactElement, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ContextCard } from "../src/blocks/ContextCard.tsx";
import { ChatThread } from "../src/chat/Thread.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, IDS } from "../src/fixtures/index.ts";
import { FeedScreen } from "../src/screens/feed/FeedScreen.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

const post = (id: string): FeedPost => {
  const p = createFixtureWorld().feed.find((x) => x.id === id);
  if (p === undefined) throw new Error(id);
  return p;
};

/** The Feed, and the chat its navigation opens: the app's routing in miniature. */
function Flow({ navigate }: { navigate: (to: string) => void }): ReactElement {
  const [route, setRoute] = useState("/feed");
  const slots = {
    navigate: (to: string) => {
      navigate(to);
      setRoute(to);
    },
  };
  return (
    <StoryWorld
      slots={slots}
      onGateway={(g) => {
        flowGateway = g;
      }}
    >
      <div style={{ height: 900 }}>
        {route.startsWith("/chat/") ? (
          <ChatThread threadId={route.slice("/chat/".length)} now={STORY_NOW} />
        ) : (
          <FeedScreen />
        )}
      </div>
    </StoryWorld>
  );
}
let flowGateway: MockGateway | undefined;
const gw = () => flowGateway as MockGateway;
const callsTo = (method: string) => gw().calls.filter((c) => c.method === method);

describe("Ask about this on a Feed item", () => {
  const briefing = post(IDS.feed.briefing);

  it("opens a new chat named for the article, with the item as a removable chip", async () => {
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<Flow navigate={navigate} />);
    const card = await screen.findByRole("article", { name: briefing.title });
    await user.click(within(card).getByRole("button", { name: "Ask about this" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/chat\//)));
    expect(callsTo("threads.create").at(-1)?.params).toMatchObject({
      kind: "side",
      title: briefing.title,
    });
    const chip = await screen.findByTestId("context-chip");
    expect(within(chip).getByText(briefing.title)).toBeTruthy();
    // The input has the cursor, and asks about the article.
    const box = screen.getByRole("textbox", { name: /^Message / });
    expect(box.getAttribute("placeholder")).toBe("Ask about this article…");
    await waitFor(() => expect(document.activeElement).toBe(box));

    await user.click(within(chip).getByRole("button", { name: /^Remove .* from this message$/ }));
    expect(screen.queryByTestId("context-chip")).toBeNull();
    expect(box.getAttribute("placeholder")).toMatch(/^Message /);
  });

  it("sends the item's id with the question and shows it as a quoted card", async () => {
    const user = userEvent.setup();
    render(<Flow navigate={() => {}} />);
    const card = await screen.findByRole("article", { name: briefing.title });
    await user.click(within(card).getByRole("button", { name: "Ask about this" }));
    await screen.findByTestId("context-chip");

    await user.type(screen.getByRole("textbox", { name: /^Message / }), "What changed?{Enter}");
    await waitFor(() => expect(callsTo("chat.send")).toHaveLength(1));
    expect(callsTo("chat.send")[0]?.params).toMatchObject({
      content: "What changed?",
      context: { kind: "feed_item", id: briefing.id },
    });
    const quoted = await screen.findByTestId("context-card");
    expect(within(quoted).getByText(briefing.title)).toBeTruthy();
    // The chip is spent: the next message is about nothing in particular.
    expect(screen.queryByTestId("context-chip")).toBeNull();
  });

  it("does not send a context once the chip is removed", async () => {
    const user = userEvent.setup();
    render(<Flow navigate={() => {}} />);
    const card = await screen.findByRole("article", { name: briefing.title });
    await user.click(within(card).getByRole("button", { name: "Ask about this" }));
    const chip = await screen.findByTestId("context-chip");
    await user.click(within(chip).getByRole("button", { name: /^Remove / }));
    await user.type(screen.getByRole("textbox", { name: /^Message / }), "hello{Enter}");
    await waitFor(() => expect(callsTo("chat.send")).toHaveLength(1));
    expect(callsTo("chat.send")[0]?.params).not.toHaveProperty("context");
  });

  it("calls a custom onAsk instead of opening a chat", async () => {
    const onAsk = vi.fn();
    const user = userEvent.setup();
    render(
      <StoryWorld slots={{ navigate: vi.fn() }}>
        <FeedScreen onAsk={onAsk} />
      </StoryWorld>,
    );
    const card = await screen.findByRole("article", { name: briefing.title });
    await user.click(within(card).getByRole("button", { name: "Ask about this" }));
    expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ id: briefing.id }));
  });

  it("has no button where no chat can open", async () => {
    render(
      <StoryWorld>
        <FeedScreen />
      </StoryWorld>,
    );
    const card = await screen.findByRole("article", { name: briefing.title });
    expect(within(card).queryByRole("button", { name: "Ask about this" })).toBeNull();
  });
});

describe("the quoted context card", () => {
  const block = {
    type: "context" as const,
    kind: "feed_item" as const,
    id: "post_1",
    title: "<b>Rust</b> 2.0",
    url: "https://www.rust-lang.org/blog",
    source: "Rust Blog",
  };

  it("shows the title and source as plain text, linking web URLs only", () => {
    render(
      <StoryWorld>
        <ContextCard block={block} />
      </StoryWorld>,
    );
    const card = screen.getByTestId("context-card");
    expect(card.textContent).toContain("<b>Rust</b> 2.0");
    expect(card.querySelector("b")).toBeNull();
    expect(within(card).getByText("Rust Blog")).toBeTruthy();
    expect(card.querySelector("a")?.getAttribute("href")).toBe("https://www.rust-lang.org/blog");
  });

  it("is not a link for a non-web URL", () => {
    render(
      <StoryWorld>
        <ContextCard block={{ ...block, url: "javascript:alert(1)" }} />
      </StoryWorld>,
    );
    expect(screen.getByTestId("context-card").querySelector("a")).toBeNull();
  });
});
