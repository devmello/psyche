import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, type FixtureWorld, IDS } from "../src/fixtures/index.ts";
import { LibraryScreen } from "../src/screens/library/LibraryScreen.tsx";
import {
  applyFilters,
  fileType,
  formatBytes,
  NO_FILTERS,
  workspacePath,
} from "../src/screens/library/library-items.ts";
import { SearchScreen } from "../src/screens/search/SearchScreen.tsx";
import { filterHits, parseSearchQuery, removeFilter } from "../src/screens/search/search-query.ts";
import type { UiSlots } from "../src/slots.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

function setup(
  ui: ReactElement,
  options: { edit?: (w: FixtureWorld) => void; slots?: UiSlots } = {},
) {
  let gateway: MockGateway | undefined;
  const navigate = vi.fn();
  const user = userEvent.setup();
  render(
    <StoryWorld
      {...(options.edit ? { edit: options.edit } : {})}
      onGateway={(g) => {
        gateway = g;
      }}
      slots={{ navigate, ...options.slots }}
    >
      {ui}
    </StoryWorld>,
  );
  const callsTo = (method: string) => {
    if (gateway === undefined) throw new Error("gateway not ready");
    return gateway.calls.filter((c) => c.method === method);
  };
  return { callsTo, navigate, user };
}

const fixture = createFixtureWorld();

// --- Search query parser ------------------------------------------------------------------------

describe("parseSearchQuery", () => {
  it("parses in:, type: and from: into scopes, client filters and query text", () => {
    const q = parseSearchQuery("in:feed type:pdf from:alice dentist");
    expect(q.text).toBe("dentist");
    expect(q.scopes).toEqual(["feed"]);
    expect(q.types).toEqual(["pdf"]);
    expect(q.from).toEqual(["alice"]);
    expect(q.queryText).toBe("dentist alice");
    expect(q.unsupported).toEqual([]);
  });

  it("accepts aliases, repeats and quoted values", () => {
    const q = parseSearchQuery('in:chat in:files from:"Jane Ortiz" "front desk"');
    expect(q.scopes).toEqual(["threads", "library"]);
    expect(q.from).toEqual(["Jane Ortiz"]);
    expect(q.text).toBe('"front desk"');
  });

  it("implies scopes from type: and from: when there is no in:", () => {
    expect(parseSearchQuery("type:.PDF slip").scopes).toEqual(["library"]);
    expect(parseSearchQuery("type:.PDF slip").types).toEqual(["pdf"]);
    expect(parseSearchQuery("from:sam projector").scopes).toEqual(["messages", "threads"]);
    expect(parseSearchQuery("dentist").scopes).toBeUndefined();
  });

  it("keeps unknown filters visible and leaves times and URLs as text", () => {
    const q = parseSearchQuery("in:ideas foo:bar meet 10:30 https://acme.com");
    expect(q.unsupported).toEqual(["in:ideas", "foo:bar"]);
    expect(q.text).toBe("meet 10:30 https://acme.com");
    expect(q.scopes).toBeUndefined();
  });

  it("removes one filter token and filters hits by type", () => {
    const raw = "in:feed type:pdf dentist";
    const q = parseSearchQuery(raw);
    const typeFilter = q.filters.find((f) => f.key === "type");
    if (typeFilter === undefined) throw new Error("no type filter");
    expect(removeFilter(raw, typeFilter)).toBe("in:feed dentist");
    const hits = filterHits(fixture.searchHits, parseSearchQuery("type:pdf"));
    expect(hits.map((h) => h.title)).toEqual(["acme-intake-form.pdf", "permission-slip.pdf"]);
  });
});

// --- Search screen ------------------------------------------------------------------------------

describe("SearchScreen", () => {
  it("shows the empty-query state", () => {
    setup(<SearchScreen debounceMs={0} />);
    expect(screen.getByText(/Search threads, tasks, memory, Library and Feed/)).toBeTruthy();
  });

  it("groups results by scope with counts and opens a result's route", async () => {
    const { navigate, user } = setup(<SearchScreen debounceMs={0} />);
    await user.type(screen.getByRole("searchbox", { name: "Search everything" }), "dentist");
    expect(await screen.findByRole("heading", { name: "Threads (1)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tasks (1)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Feed (1)" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Dentist booking:\s*running/ }));
    expect(navigate).toHaveBeenCalledWith(`/agent/activity/${IDS.tasks.dentist}`);
  });

  it("sends scopes from typed filters and shows removable chips", async () => {
    const { callsTo, user } = setup(<SearchScreen debounceMs={0} initialQuery="in:feed dentist" />);
    expect(await screen.findByRole("heading", { name: "Feed (1)" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Threads/ })).toBeNull();
    expect(callsTo("search.query").at(-1)?.params).toEqual({ query: "dentist", scopes: ["feed"] });
    await user.click(screen.getByRole("button", { name: "Remove filter in: Feed" }));
    expect(await screen.findByRole("heading", { name: /Threads/ })).toBeTruthy();
  });

  it("marks memory hits with a provenance chip", async () => {
    setup(<SearchScreen debounceMs={0} initialQuery="morning" />);
    expect(await screen.findByRole("heading", { name: "Memory (1)" })).toBeTruthy();
    expect(screen.getByText("provenance unknown")).toBeTruthy();
  });

  it("says when nothing matches", async () => {
    const { user } = setup(<SearchScreen debounceMs={0} initialQuery="lighthouse" />);
    expect(await screen.findByText(/Nothing matches “lighthouse”/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText(/Search threads, tasks, memory/)).toBeTruthy();
  });
});

// --- Library ------------------------------------------------------------------------------------

describe("library helpers", () => {
  it("formats sizes and types and maps system paths to the workspace", () => {
    expect(formatBytes(184_320)).toBe("180 KB");
    expect(formatBytes(1_204_880)).toBe("1.1 MB");
    const soul = fixture.library.find((i) => i.id === IDS.library.soul);
    const slip = fixture.library.find((i) => i.id === IDS.library.permissionSlip);
    if (soul === undefined || slip === undefined) throw new Error("fixture");
    expect(workspacePath(soul)).toBe("SOUL.md");
    expect(fileType(slip)).toBe("PDF");
  });

  it("filters by type, source task and date", () => {
    const docs = fixture.library.filter((i) => i.kind === "document");
    expect(applyFilters(docs, NO_FILTERS, STORY_NOW)).toHaveLength(2);
    expect(
      applyFilters(docs, { ...NO_FILTERS, taskId: IDS.tasks.dentist }, STORY_NOW).map((i) => i.id),
    ).toEqual([IDS.library.intakeForm]);
    expect(applyFilters(docs, { ...NO_FILTERS, date: "week" }, STORY_NOW).map((i) => i.id)).toEqual(
      [IDS.library.intakeForm],
    );
  });
});

describe("LibraryScreen", () => {
  it("lists documents with kind, size, Task chip and tags", async () => {
    const openLibraryItem = vi.fn();
    const onSendToChat = vi.fn();
    const { navigate, user } = setup(
      <LibraryScreen now={STORY_NOW} onSendToChat={onSendToChat} />,
      { slots: { openLibraryItem } },
    );
    const form = (await screen.findByText("acme-intake-form.pdf")).closest(
      "article",
    ) as HTMLElement;
    expect(within(form).getByText(/Document · PDF · 180 KB/)).toBeTruthy();
    expect(within(form).getByText("#dentist")).toBeTruthy();
    await user.click(await within(form).findByRole("button", { name: "Task: Dentist booking" }));
    expect(navigate).toHaveBeenCalledWith(`/agent/activity/${IDS.tasks.dentist}`);
    await user.click(within(form).getByRole("button", { name: "Open acme-intake-form.pdf" }));
    expect(openLibraryItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: IDS.library.intakeForm }),
    );
    // One Open per card; the rest sit under ⋯ (§3.12).
    expect(within(form).getAllByRole("button", { name: /^Open/ })).toHaveLength(1);
    await user.click(
      within(form).getByRole("button", { name: "More actions for acme-intake-form.pdf" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Send to chat" }));
    expect(onSendToChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: IDS.library.intakeForm }),
    );
  });

  it("switches tabs and opens system files in the editor", async () => {
    const { navigate, user } = setup(<LibraryScreen now={STORY_NOW} />);
    await screen.findByText("acme-intake-form.pdf");
    await user.click(screen.getByRole("tab", { name: "System files" }));
    await user.click(await screen.findByRole("button", { name: "Open SOUL.md in the editor" }));
    expect(navigate).toHaveBeenCalledWith("/agent/soul?file=SOUL.md");
    await user.click(screen.getByRole("button", { name: "Open 2026-10-18.md in the editor" }));
    expect(navigate).toHaveBeenCalledWith(
      `/agent/soul?file=${encodeURIComponent("memory/2026-10-18.md")}`,
    );
  });

  it("shows the quarantine badge on downloads until the file is trusted", async () => {
    const onTrust = vi.fn(() => Promise.resolve());
    const { user } = setup(<LibraryScreen now={STORY_NOW} section="downloads" onTrust={onTrust} />);
    const invoice = (await screen.findByText("invoice.pdf")).closest("article") as HTMLElement;
    expect(within(invoice).getByText("Quarantined")).toBeTruthy();
    await user.click(within(invoice).getByRole("button", { name: "Trust this file" }));
    expect(onTrust).toHaveBeenCalledWith(
      expect.objectContaining({ id: IDS.library.invoiceDownload }),
    );
    await waitFor(() => expect(within(invoice).queryByText("Quarantined")).toBeNull());
  });

  it("filters by type and clears filters from the empty state", async () => {
    const { user } = setup(<LibraryScreen now={STORY_NOW} section="artifacts" />);
    await screen.findByText("half-marathon-plan.pdf");
    await user.selectOptions(screen.getByLabelText("Type"), "HTML");
    expect(screen.queryByText("half-marathon-plan.pdf")).toBeNull();
    expect(screen.getByText("Subscription audit · October")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Date"), "today");
    expect(await screen.findByText("No files match these filters.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("half-marathon-plan.pdf")).toBeTruthy();
  });

  it("toggles between grid and list", async () => {
    const { user } = setup(<LibraryScreen now={STORY_NOW} />);
    await screen.findByText("acme-intake-form.pdf");
    const list = screen.getByRole("button", { name: "List" });
    expect(list.getAttribute("aria-pressed")).toBe("false");
    await user.click(list);
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a section's empty state", async () => {
    setup(<LibraryScreen now={STORY_NOW} section="images" />, {
      edit: (w) => {
        w.library = w.library.filter((i) => i.kind !== "image");
      },
    });
    expect(await screen.findByText(/No images yet/)).toBeTruthy();
  });
});
