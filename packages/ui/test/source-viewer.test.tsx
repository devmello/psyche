import type { EntitySummary, LifeFactHit, SearchHit } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeAnswerCard } from "../src/screens/search/LifeAnswerCard.tsx";
import { SearchSurface } from "../src/screens/search/SearchSurface.tsx";
import { SourceViewer } from "../src/screens/search/SourceViewer.tsx";
import type { UiSlots } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const entity: EntitySummary = {
  id: "e1",
  kind: "person",
  name: "Sam Lee",
  subtitle: null,
  summary: null,
  status: "active",
  lastInteractionAt: null,
  openLoops: 0,
  pinned: false,
  isOwner: false,
};
const fact = (over: Partial<LifeFactHit> = {}): LifeFactHit => ({
  factId: "f1",
  entity,
  attribute: "employer",
  value: "Initech",
  provenance: "untrusted",
  review: "accepted",
  quote: "I work at Initech",
  source: "mail",
  docId: "mail:123",
  observedAt: "2026-09-30T10:00:00.000Z",
  learnedAt: "2026-10-02T10:00:00.000Z",
  ...over,
});
const sourceHit = (id: string, over: Partial<SearchHit> = {}): SearchHit => ({
  scope: "connectors",
  id,
  title: "Contract timeline",
  snippet: "The contract will be ready on Friday <b>not markup</b> https://evil.example",
  score: 1,
  threadId: null,
  route: null,
  provenance: "untrusted",
  createdAt: Date.parse("2026-10-03T09:00:00.000Z"),
  ...over,
});

function mount(ui: React.ReactNode, hits: SearchHit[], slots: UiSlots = {}) {
  return render(
    <StoryWorld
      edit={(w) => {
        w.searchHits = hits;
      }}
      slots={slots}
    >
      {ui}
    </StoryWorld>,
  );
}

const answer = (f: LifeFactHit) => (
  <LifeAnswerCard
    state={{
      phase: "done",
      onAsk: () => undefined,
      result: { answer: "Sam works at Initech [1].", facts: [f], reason: null },
    }}
  />
);

describe("a citation chip opens the source passage", () => {
  it("shows the passage with its source and date under the fact, as plain text", async () => {
    mount(answer(fact()), [sourceHit("mail:123")]);
    fireEvent.click(screen.getByRole("button", { name: "Sam Lee: Works at" }));
    expect(screen.queryByTestId("source-viewer")).toBeNull();
    fireEvent.click(screen.getByTestId("life-answer-open-source"));
    const viewer = await screen.findByTestId("source-text");
    // What the index holds, verbatim: markup and links stay text.
    expect(viewer.textContent).toContain("<b>not markup</b> https://evil.example");
    expect(viewer.querySelector("b, a")).toBeNull();
    const panel = screen.getByRole("region", { name: "Source passage" });
    expect(panel.textContent).toContain("Mail, Oct 3");
    expect(panel.textContent).toContain("Contract timeline");
    expect(panel.textContent).toContain("Written by someone else");
    // Hides again.
    fireEvent.click(screen.getByTestId("life-answer-open-source"));
    expect(screen.queryByTestId("source-viewer")).toBeNull();
  });

  it("has no source button for a fact whose citation was never indexed", () => {
    mount(answer(fact({ docId: null })), []);
    fireEvent.click(screen.getByRole("button", { name: "Sam Lee: Works at" }));
    expect(screen.queryByTestId("life-answer-open-source")).toBeNull();
    cleanup();
    const { docId: _drop, ...older } = fact();
    mount(answer(older), []);
    fireEvent.click(screen.getByRole("button", { name: "Sam Lee: Works at" }));
    expect(screen.queryByTestId("life-answer-open-source")).toBeNull();
  });

  it("says so when the passage is gone from the index", async () => {
    mount(answer(fact({ docId: "mail:gone" })), [sourceHit("mail:123")]);
    fireEvent.click(screen.getByRole("button", { name: "Sam Lee: Works at" }));
    fireEvent.click(screen.getByTestId("life-answer-open-source"));
    expect((await screen.findByTestId("source-viewer")).textContent).toContain(
      "That source is no longer in the index.",
    );
  });
});

describe("the source viewer's open button", () => {
  it("opens a mail message through the host with the document id and nothing else", async () => {
    const openSource = vi.fn(async () => "mail" as const);
    mount(<SourceViewer docId="mail:123" />, [sourceHit("mail:123")], { openSource });
    const button = await screen.findByRole("button", { name: "Open in Mail" });
    fireEvent.click(button);
    expect(openSource).toHaveBeenCalledExactlyOnceWith("mail:123");
  });

  it("is absent where the host has no opener, and for a source with no safe link", async () => {
    mount(<SourceViewer docId="mail:123" />, [sourceHit("mail:123")]);
    await screen.findByTestId("source-text");
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    const openSource = vi.fn(async () => "mail" as const);
    mount(<SourceViewer docId="notes:9" />, [sourceHit("notes:9")], { openSource });
    await screen.findByTestId("source-text");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("falls back to the passage and says so when the host opened nothing", async () => {
    const openSource = vi.fn(async () => "none" as const);
    mount(<SourceViewer docId="mail:123" />, [sourceHit("mail:123")], { openSource });
    fireEvent.click(await screen.findByRole("button", { name: "Open in Mail" }));
    expect((await screen.findByRole("status")).textContent).toContain("Couldn't open it");
    expect(screen.getByTestId("source-text").textContent).toContain("contract will be ready");
  });

  it("also says so when the host refuses", async () => {
    const openSource = vi.fn(async () => {
      throw new Error("forbidden");
    });
    mount(<SourceViewer docId="mail:123" />, [sourceHit("mail:123")], { openSource });
    fireEvent.click(await screen.findByRole("button", { name: "Open in Mail" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Couldn't open"));
  });
});

describe("a search result with no pane to open in", () => {
  const surface = (hit: SearchHit) => (
    <SearchSurface
      variant="page"
      query="contract"
      onQueryChange={() => undefined}
      hits={[hit]}
      actions={[]}
      preview
    />
  );

  it("shows the source passage in the preview instead of a disabled Open button", async () => {
    const hit = sourceHit("mail:123");
    mount(surface(hit), [hit]);
    const preview = screen.getByTestId("search-preview");
    expect(await within(preview).findByTestId("source-viewer")).toBeTruthy();
    expect(within(preview).queryByRole("button", { name: "Open" })).toBeNull();
  });

  it("keeps the Open button for a result that has a route", () => {
    const hit = sourceHit("lib-1", { scope: "library", route: "/library/all?item=lib-1" });
    mount(surface(hit), [hit]);
    const preview = screen.getByTestId("search-preview");
    expect(within(preview).getByRole("button", { name: "Open" })).toBeTruthy();
    expect(within(preview).queryByTestId("source-viewer")).toBeNull();
  });
});

describe("narrow windows, cloud connectors and side chats", () => {
  const surface = (hits: SearchHit[], extra: { preview?: boolean; side?: () => void } = {}) => (
    <SearchSurface
      variant="page"
      query="contract"
      onQueryChange={() => undefined}
      hits={hits}
      actions={[]}
      preview={extra.preview ?? false}
      {...(extra.side ? { onOpenInSideChat: extra.side } : {})}
    />
  );

  it("opens a source passage above the results when there is no preview column", async () => {
    const hit = sourceHit("mail:123");
    mount(surface([hit]), [hit]);
    expect(screen.queryByTestId("source-viewer")).toBeNull();
    fireEvent.click(screen.getAllByRole("option")[0] as HTMLElement);
    expect(await screen.findByTestId("source-text")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide source" }));
    expect(screen.queryByTestId("source-viewer")).toBeNull();
  });

  it("does not treat a cached cloud-connector document as a source passage", () => {
    const hit = sourceHit("gmail-cache-77");
    mount(surface([hit], { preview: true }), [hit]);
    const preview = screen.getByTestId("search-preview");
    expect(within(preview).queryByTestId("source-viewer")).toBeNull();
  });

  it("offers no side chat about Messages, Contacts or Memory, and still does for Mail", () => {
    const side = vi.fn();
    for (const [id, offered] of [
      ["messages:1", false],
      ["contacts:1", false],
      ["memory:1", false],
      ["mail:1", true],
    ] as const) {
      const hit = sourceHit(id);
      const view = mount(surface([hit], { preview: true, side }), [hit]);
      const preview = screen.getByTestId("search-preview");
      expect(!!within(preview).queryByRole("button", { name: "Open in a side chat" }), id).toBe(
        offered,
      );
      view.unmount();
    }
  });
});
