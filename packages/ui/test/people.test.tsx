import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { kitchen, PEOPLE_IDS, samLee, suggestions, summaries } from "../src/fixtures/people.ts";
import { PersonCard, ProjectCard } from "../src/people/EntityCard.tsx";
import { EntityRow } from "../src/people/EntityRow.tsx";
import { SuggestionCard } from "../src/people/SuggestionCard.tsx";
import { SearchSurface } from "../src/screens/search/SearchSurface.tsx";
import { STORY_NOW } from "../src/stories/harness.tsx";

const actions = () => ({
  onSetFact: vi.fn(),
  onRetractFact: vi.fn(),
  onUpdateLoop: vi.fn(),
  onSaveNotes: vi.fn(),
  onSetStatus: vi.fn(),
  onTogglePin: vi.fn(),
  onMerge: vi.fn(),
  onForget: vi.fn(),
  onOpenEntity: vi.fn(),
  onOpenLink: vi.fn(),
});

describe("PersonCard", () => {
  it("shows the header, summary and facts with where each came from", () => {
    render(<PersonCard entity={samLee} now={STORY_NOW} />);
    const card = screen.getByRole("article", { name: "Sam Lee" });
    expect(within(card).getByRole("heading", { name: "Sam Lee" })).toBeTruthy();
    expect(within(card).getByText("Person · Acme")).toBeTruthy();
    expect(within(card).getByText(/Head of product at Acme/)).toBeTruthy();
    expect(within(card).getByText("Summary by Psyche · Oct 17")).toBeTruthy();
    expect(within(card).getByText("Head of product")).toBeTruthy();
    expect(within(card).getAllByText("Psyche inferred this").length).toBeGreaterThan(0);
    expect(within(card).getAllByText("From you").length).toBeGreaterThan(0);
  });

  it("shows a claim from someone else's mail as their words, with the sender", () => {
    render(<PersonCard entity={samLee} now={STORY_NOW} />);
    expect(screen.getByText("“Heads up, I'm moving to Berlin in the spring.”")).toBeTruthy();
    expect(screen.getByText("From Sam Lee's mail, Oct 12")).toBeTruthy();
    expect(screen.getAllByText("A claim in someone else's message").length).toBe(2);
    // The claim's value is never shown as a plain fact.
    expect(screen.queryByText("Moving to Berlin")).toBeNull();
  });

  it("edits a fact in place and saves it as the owner's value", async () => {
    const a = actions();
    const user = userEvent.setup();
    render(<PersonCard entity={samLee} now={STORY_NOW} {...a} />);
    await user.click(screen.getByRole("button", { name: "Edit Role" }));
    const input = screen.getByRole("textbox", { name: "Role" });
    await user.clear(input);
    await user.type(input, "Chief product officer");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(a.onSetFact).toHaveBeenCalledWith(samLee, "role", "Chief product officer");
  });

  it("cancels an edit with Escape and saves nothing", async () => {
    const a = actions();
    const user = userEvent.setup();
    render(<PersonCard entity={samLee} now={STORY_NOW} {...a} />);
    await user.click(screen.getByRole("button", { name: "Edit Role" }));
    await user.type(screen.getByRole("textbox", { name: "Role" }), "x{Escape}");
    expect(screen.queryByRole("textbox", { name: "Role" })).toBeNull();
    expect(a.onSetFact).not.toHaveBeenCalled();
  });

  it("retracts a fact with “This is wrong”", async () => {
    const a = actions();
    const user = userEvent.setup();
    render(<PersonCard entity={samLee} now={STORY_NOW} {...a} />);
    const role = screen.getByText("Head of product").closest("div.group\\/row") as HTMLElement;
    await user.click(within(role).getByRole("button", { name: "This is wrong" }));
    expect(a.onRetractFact).toHaveBeenCalledWith(
      samLee,
      expect.objectContaining({ id: "fact_sam_role" }),
    );
  });

  it("adds an owner fact from the allowlist", async () => {
    const a = actions();
    const user = userEvent.setup();
    render(<PersonCard entity={samLee} now={STORY_NOW} {...a} />);
    await user.click(screen.getByRole("button", { name: "Add a fact" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Fact" }), "timezone");
    await user.type(screen.getByRole("textbox", { name: "Value" }), "Pacific");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(a.onSetFact).toHaveBeenCalledWith(samLee, "timezone", "Pacific");
    // The allowlist has no sensitive attributes.
    await user.click(screen.getByRole("button", { name: "Add a fact" }));
    const options = within(screen.getByRole("combobox", { name: "Fact" }))
      .getAllByRole("option")
      .map((o) => o.getAttribute("value"));
    expect(options).not.toContain("health");
    expect(options).toContain("relationship_to_owner");
  });

  it("marks an open loop done and dismisses one that isn't a loop", async () => {
    const a = actions();
    const user = userEvent.setup();
    render(<PersonCard entity={samLee} now={STORY_NOW} {...a} />);
    await user.click(
      screen.getByRole("checkbox", { name: "Mark “Send Sam the revised budget” done" }),
    );
    expect(a.onUpdateLoop).toHaveBeenCalledWith(
      samLee,
      expect.objectContaining({ id: "loop_budget" }),
      "done",
    );
    const sow = screen.getByText("Signed SOW from Sam").closest("div.group\\/row") as HTMLElement;
    await user.click(within(sow).getByRole("button", { name: "Not a loop" }));
    expect(a.onUpdateLoop).toHaveBeenLastCalledWith(
      samLee,
      expect.objectContaining({ id: "loop_sow" }),
      "dismissed",
    );
  });

  it("keeps a loop from someone else's mail a suggestion until the owner confirms it", async () => {
    const a = actions();
    const user = userEvent.setup();
    render(<PersonCard entity={samLee} now={STORY_NOW} {...a} />);
    const injected = screen.getByText("Pay Sam $500").closest("div.group\\/row") as HTMLElement;
    expect(within(injected).queryByRole("checkbox")).toBeNull();
    expect(within(injected).getByText(/Suggested from Sam Lee's mail/)).toBeTruthy();
    await user.click(within(injected).getByRole("button", { name: "Confirm" }));
    expect(a.onUpdateLoop).toHaveBeenLastCalledWith(
      samLee,
      expect.objectContaining({ id: "loop_injected" }),
      "open",
    );
    await user.click(within(injected).getByRole("button", { name: "Not a loop" }));
    expect(a.onUpdateLoop).toHaveBeenLastCalledWith(
      samLee,
      expect.objectContaining({ id: "loop_injected" }),
      "dismissed",
    );
  });

  it("opens interactions and loops in their app, and related cards", async () => {
    const a = actions();
    const user = userEvent.setup();
    render(<PersonCard entity={samLee} now={STORY_NOW} {...a} />);
    await user.click(screen.getAllByRole("button", { name: "Open in Calendar" })[0] as HTMLElement);
    expect(a.onOpenLink).toHaveBeenCalledWith("calendar://event/launch-weekly-1016");
    await user.click(screen.getByRole("button", { name: /Q4 launch/ }));
    expect(a.onOpenEntity).toHaveBeenCalledWith(PEOPLE_IDS.launch);
  });

  it("saves the owner's notes verbatim", async () => {
    const a = actions();
    const user = userEvent.setup();
    render(<PersonCard entity={samLee} now={STORY_NOW} {...a} />);
    const notes = screen.getByRole("textbox", { name: "Notes" });
    expect(screen.queryByRole("button", { name: "Save notes" })).toBeNull();
    await user.type(notes, " Loves the Giants.");
    await user.click(screen.getByRole("button", { name: "Save notes" }));
    expect(a.onSaveNotes).toHaveBeenCalledWith(
      samLee,
      "Prefers short agendas. Ask about the Berlin move after the launch. Loves the Giants.",
    );
  });

  it("puts Merge and Forget under ⋯", async () => {
    const a = actions();
    const user = userEvent.setup();
    render(<PersonCard entity={samLee} now={STORY_NOW} {...a} />);
    await user.click(screen.getByRole("button", { name: "More for Sam Lee" }));
    await user.click(await screen.findByRole("menuitem", { name: "Merge…" }));
    expect(a.onMerge).toHaveBeenCalledWith(samLee);
    await user.click(screen.getByRole("button", { name: "More for Sam Lee" }));
    await user.click(await screen.findByRole("menuitem", { name: "Forget…" }));
    expect(a.onForget).toHaveBeenCalledWith(samLee);
  });

  it("is read-only without write callbacks", () => {
    render(<PersonCard entity={samLee} now={STORY_NOW} />);
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
    expect(screen.queryByRole("button", { name: "This is wrong" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a fact" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More for Sam Lee" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "Notes" }) as HTMLTextAreaElement).readOnly).toBe(
      true,
    );
  });

  it("shows a skeleton while loading and the error with a retry", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<PersonCard entity={null} now={STORY_NOW} loading />);
    expect(screen.getByText("Loading the card")).toBeTruthy();
    rerender(
      <PersonCard entity={null} now={STORY_NOW} error="entity not found" onRetry={onRetry} />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/Psyche couldn't load this card/);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("ProjectCard", () => {
  it("shows status, next step, members, loops and the timeline", () => {
    render(<ProjectCard entity={kitchen} now={STORY_NOW} />);
    const card = screen.getByRole("article", { name: "Kitchen remodel" });
    expect(within(card).getByText("Project · Active")).toBeTruthy();
    expect(within(card).getByRole("radio", { name: "Active" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(within(card).getByText("Pay the deposit so Rivera can order cabinets")).toBeTruthy();
    expect(within(card).getByRole("button", { name: /Dana Kim/ })).toBeTruthy();
    expect(within(card).getByText("Pay the cabinet deposit")).toBeTruthy();
    expect(within(card).getByText("Site visit")).toBeTruthy();
  });

  it("changes the status and opens a member's card", async () => {
    const a = actions();
    const user = userEvent.setup();
    render(<ProjectCard entity={kitchen} now={STORY_NOW} {...a} />);
    await user.click(screen.getByRole("radio", { name: "Paused" }));
    expect(a.onSetStatus).toHaveBeenCalledWith(kitchen, "paused");
    await user.click(screen.getByRole("button", { name: /Dana Kim/ }));
    expect(a.onOpenEntity).toHaveBeenCalledWith(PEOPLE_IDS.dana);
  });

  it("flags an overdue loop", () => {
    render(<ProjectCard entity={kitchen} now={STORY_NOW} />);
    const tiles = screen
      .getByText("Tile samples from Dana")
      .closest("div.group\\/row") as HTMLElement;
    expect(within(tiles).getByText(/overdue since Oct 16/)).toBeTruthy();
    const deposit = screen
      .getByText("Pay the cabinet deposit")
      .closest("div.group\\/row") as HTMLElement;
    expect(within(deposit).getByText(/due Oct 24/).textContent).not.toMatch(/overdue/);
  });
});

describe("EntityRow", () => {
  it("shows the callout line and opens the entity", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    const sam = summaries[0];
    if (sam === undefined) throw new Error("fixture");
    render(<EntityRow entity={sam} now={STORY_NOW} onOpen={onOpen} />);
    const row = screen.getByRole("button", { name: /Sam Lee/ });
    expect(row.textContent).toMatch(/Acme · last talked .+ · 2 open loops/);
    await user.click(row);
    expect(onOpen).toHaveBeenCalledWith(sam);
  });
});

describe("SuggestionCard", () => {
  it("asks about a merge and answers Confirm / Not the same / Later", async () => {
    const onAnswer = vi.fn();
    const user = userEvent.setup();
    const merge = suggestions[0];
    if (merge === undefined) throw new Error("fixture");
    render(<SuggestionCard suggestion={merge} onAnswer={onAnswer} />);
    expect(
      screen.getByRole("heading", {
        name: "Is Sam Lee (sam@acme.com) the same as Sam L. (samlee.home@gmail.com)?",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/You replied to both/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Not the same" }));
    expect(onAnswer).toHaveBeenCalledWith(merge, "reject");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onAnswer).toHaveBeenLastCalledWith(merge, "accept");
  });

  it("asks whether something is a project", () => {
    const project = suggestions[1];
    if (project === undefined) throw new Error("fixture");
    render(<SuggestionCard suggestion={project} />);
    expect(
      screen.getByRole("heading", { name: "Is this a project: Backyard fence?" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not a project" })).toBeTruthy();
  });
});

describe("Search with people and projects", () => {
  const hit = {
    scope: "threads" as const,
    id: "th_sam",
    title: "Budget with Sam",
    snippet: "the revised budget",
    score: 1,
    threadId: "th_sam",
    route: "/chat/th_sam",
  };

  it("lists People and Projects first, before the other groups", () => {
    render(
      <SearchSurface
        variant="page"
        query="sam"
        onQueryChange={() => {}}
        hits={[hit]}
        entities={summaries}
        now={STORY_NOW}
      />,
    );
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups[0]).toMatch(/^People/);
    expect(groups[1]).toMatch(/^Projects/);
    expect(groups[2]).toMatch(/^Threads/);
    const people = screen.getAllByRole("group")[0] as HTMLElement;
    expect(within(people).getByRole("option", { name: /Sam Lee/ })).toBeTruthy();
    expect(within(people).getByText(/Acme · last talked .+ · 2 open loops/)).toBeTruthy();
    expect(
      within(screen.getAllByRole("group")[1] as HTMLElement).getByText("Kitchen remodel"),
    ).toBeTruthy();
  });

  it("opens a person from the results and shows their card in the preview", async () => {
    const onOpenEntity = vi.fn();
    const user = userEvent.setup();
    render(
      <SearchSurface
        variant="page"
        query="sam"
        onQueryChange={() => {}}
        hits={[hit]}
        entities={summaries}
        now={STORY_NOW}
        preview
        onOpenEntity={onOpenEntity}
        renderEntityPreview={(e) => (
          <PersonCard entity={e.id === samLee.id ? samLee : null} now={STORY_NOW} />
        )}
      />,
    );
    const preview = screen.getByTestId("search-preview");
    expect(within(preview).getByRole("article", { name: "Sam Lee" })).toBeTruthy();
    await user.type(screen.getByRole("combobox"), "{Enter}");
    expect(onOpenEntity).toHaveBeenCalledWith(expect.objectContaining({ id: PEOPLE_IDS.samLee }));
  });

  it("shows no entity groups without a query", () => {
    render(
      <SearchSurface
        variant="page"
        query=""
        onQueryChange={() => {}}
        hits={[]}
        entities={summaries}
      />,
    );
    expect(screen.queryByRole("option", { name: /Sam Lee/ })).toBeNull();
  });
});
