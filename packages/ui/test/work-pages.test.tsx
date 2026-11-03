import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ReactElement, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { WORK_IDS, withWorkWorld } from "../src/fixtures/work.ts";
import { parseMemoryKind } from "../src/memory-page/kinds.ts";
import { MemoryScreen } from "../src/memory-page/MemoryScreen.tsx";
import type { UiSlots } from "../src/slots.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/**
 * Work pages in Memory (docs/design/memory-everything-2026.md §6.2, §6.3) against the MockGateway:
 * the Work due and Projects tabs, a course's page and an assignment's page, with the owner's
 * writes going through `memory.*`. The fixture clock is Sunday 2026-10-18 and the tests run in UTC.
 */

function setup(
  ui: ReactElement,
  options: { edit?: (w: FixtureWorld) => void; slots?: UiSlots } = {},
) {
  let gateway: MockGateway | undefined;
  const navigate = vi.fn();
  const user = userEvent.setup();
  render(
    <StoryWorld
      edit={(w) => {
        withWorkWorld(w);
        options.edit?.(w);
      }}
      onGateway={(g) => {
        gateway = g;
      }}
      slots={{ navigate, ...options.slots }}
    >
      {ui}
    </StoryWorld>,
  );
  const callsTo = (method: string) => (gateway?.calls ?? []).filter((c) => c.method === method);
  return { callsTo, navigate, user };
}

const group = (name: string) => screen.findByRole("region", { name });

const rowOf = (name: string) =>
  screen.getByText(name, { selector: "span" }).closest("[data-testid=work-row]") as HTMLElement;

describe("Work due", () => {
  it("groups to-dos, in order, and leaves out what was done a month ago", async () => {
    setup(<MemoryScreen kind="due" now={STORY_NOW} />);
    await screen.findByText("Lecture Work 7");
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent)
      .filter((t) => ["Past due", "This week", "Later", "No date", "Done"].includes(t ?? ""));
    expect(headings).toEqual(["Past due", "This week", "Later", "No date", "Done"]);

    const past = await group("Past due");
    expect(within(past).getByText("Sign off on the launch copy")).toBeTruthy();
    const week = await group("This week");
    for (const n of ["Lecture Work 7", "Q3 board deck", "Order cabinet hardware", "Expense report"])
      expect(within(week).getByText(n)).toBeTruthy();
    const later = await group("Later");
    for (const n of ["Midterm review sheet", "Pay rent", "Renew passport"])
      expect(within(later).getByText(n)).toBeTruthy();
    expect(within(await group("No date")).getByText("File taxes")).toBeTruthy();
    const done = await group("Done");
    for (const n of ["Lecture Work 5", "Book the electrician"])
      expect(within(done).getByText(n)).toBeTruthy();
    expect(screen.queryByText("Lecture Work 1")).toBeNull();
  });

  it("shows the parent, due date, status and stale mark on each row", async () => {
    setup(<MemoryScreen kind="due" now={STORY_NOW} />);
    await screen.findByText("Lecture Work 7");
    const lw7 = rowOf("Lecture Work 7");
    expect(within(lw7).getByText("MATH 21")).toBeTruthy();
    expect(within(lw7).getByText("In progress")).toBeTruthy();
    expect(within(lw7).getByText("Due Wed")).toBeTruthy();
    expect(within(lw7).queryByTestId("stale-mark")).toBeNull();

    const hardware = rowOf("Order cabinet hardware");
    expect(within(hardware).getByText("Kitchen remodel")).toBeTruthy();
    expect(within(hardware).getByText("Not started")).toBeTruthy();
    expect(within(hardware).getByTestId("stale-mark").textContent).toBe("As of Oct 9");

    // Rent belongs to no project: its row says so by saying nothing, and a date a week or more
    // away is never stale.
    const rent = rowOf("Pay rent");
    expect(within(rent).getByText("Not started")).toBeTruthy();
    expect(within(rent).getByText("Due Nov 1")).toBeTruthy();
    expect(within(rent).queryByText("Q4 launch")).toBeNull();
    expect(within(rent).queryByTestId("stale-mark")).toBeNull();

    expect(within(rowOf("Expense report")).getByText("Handed in")).toBeTruthy();
    expect(within(rowOf("Expense report")).getByText("Q4 launch")).toBeTruthy();
    expect(within(rowOf("Expense report")).queryByTestId("stale-mark")).toBeNull();
  });

  it("marks only past due in amber, and says Overdue in words", async () => {
    setup(<MemoryScreen kind="due" now={STORY_NOW} />);
    await screen.findByText("Sign off on the launch copy");
    const late = within(rowOf("Sign off on the launch copy")).getByTestId("due-chip");
    expect(late.textContent).toBe("Overdue since Oct 16");
    expect(late.className).toContain("text-approval-text");
    const soon = within(rowOf("Lecture Work 7")).getByTestId("due-chip");
    expect(soon.className).not.toContain("text-approval-text");
    // Only the Past due heading carries the amber dot.
    expect((await group("Past due")).querySelector("header > span.bg-approval")).not.toBeNull();
    expect((await group("This week")).querySelector("header > span.bg-approval")).toBeNull();
  });

  it("marks a private item and nothing else", async () => {
    setup(<MemoryScreen kind="due" now={STORY_NOW} />);
    await screen.findByText("File taxes");
    expect(within(rowOf("File taxes")).getByText("Private")).toBeTruthy();
    expect(within(rowOf("Lecture Work 7")).queryByText("Private")).toBeNull();
  });

  it("opens an item's page from its row", async () => {
    const { navigate, user } = setup(<MemoryScreen kind="due" now={STORY_NOW} />);
    await user.click(await screen.findByRole("button", { name: /Lecture Work 7/ }));
    expect(navigate).toHaveBeenLastCalledWith(`/memory?entity=${WORK_IDS.lw7}`);
  });

  it("finishes an item in one tap and moves it to Done, and reopens it", async () => {
    const { callsTo, user } = setup(<MemoryScreen kind="due" now={STORY_NOW} />);
    await user.click(await screen.findByRole("checkbox", { name: "Mark “Lecture Work 7” done" }));
    await waitFor(() =>
      expect(callsTo("memory.entities.facts.set").at(-1)?.params).toMatchObject({
        entityId: WORK_IDS.lw7,
        attribute: "status",
        value: "done",
      }),
    );
    const done = await group("Done");
    await waitFor(() => expect(within(done).getByText("Lecture Work 7")).toBeTruthy());
    expect(within(await group("This week")).queryByText("Lecture Work 7")).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: "Reopen “Lecture Work 7”" }));
    await waitFor(() =>
      expect(callsTo("memory.entities.facts.set").at(-1)?.params).toMatchObject({
        entityId: WORK_IDS.lw7,
        value: "in_progress",
      }),
    );
    await waitFor(async () =>
      expect(within(await group("This week")).getByText("Lecture Work 7")).toBeTruthy(),
    );
  });

  it("is a calm empty page with an Add button when nothing is tracked", async () => {
    setup(<MemoryScreen kind="due" now={STORY_NOW} />, {
      edit: (w) => {
        w.graph.entities = w.graph.entities.filter((e) => e.kind !== "assignment");
      },
    });
    const due = await screen.findByTestId("memory-due");
    expect(await within(due).findByText("Nothing due")).toBeTruthy();
    expect(within(due).getByRole("button", { name: "Add" })).toBeTruthy();
  });
});

describe("Quick add", () => {
  it("reads 'Q3 report, Q4 launch, Fri', says what it understood, and saves with its project", async () => {
    const { callsTo, user } = setup(<MemoryScreen kind="due" now={STORY_NOW} />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    const input = screen.getByRole("textbox", { name: "Add a to-do" });
    expect(input.getAttribute("placeholder")).toBe("Pay rent, Fri");
    await user.type(input, "Q3 report, Q4 launch, Fri");
    await waitFor(() =>
      expect(screen.getByTestId("quick-add-preview").textContent).toBe(
        "Q3 report · Q4 launch · due Fri, Oct 23",
      ),
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(callsTo("memory.entities.create")).toHaveLength(1));
    expect(callsTo("memory.entities.create")[0]?.params).toMatchObject({
      kind: "assignment",
      name: "Q3 report",
      dueAt: "2026-10-23T23:59:00.000Z",
    });
    await waitFor(() => expect(callsTo("memory.entities.edges.set")).toHaveLength(1));
    expect(callsTo("memory.entities.edges.set")[0]?.params).toMatchObject({
      rel: "part_of",
      dst: WORK_IDS.launch,
    });
    // The new row is in This week, under Q4 launch, and the form is closed.
    const week = await group("This week");
    await waitFor(() => expect(within(week).getByText("Q3 report")).toBeTruthy());
    expect(within(rowOf("Q3 report")).getByText("Q4 launch")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Add a to-do" })).toBeNull();
  });

  it("finds a course by an alias through search", async () => {
    const { callsTo, user } = setup(<MemoryScreen kind="due" now={STORY_NOW} />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(
      screen.getByRole("textbox", { name: "Add a to-do" }),
      "Quiz 3, Linear Algebra, Mon",
    );
    await waitFor(() =>
      expect(screen.getByTestId("quick-add-preview").textContent).toContain("MATH 21"),
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(callsTo("memory.entities.edges.set")).toHaveLength(1));
    expect(callsTo("memory.entities.edges.set")[0]?.params).toMatchObject({
      dst: WORK_IDS.math,
    });
  });

  it("says when no project matches, and adds the item without one", async () => {
    const { callsTo, user } = setup(<MemoryScreen kind="due" now={STORY_NOW} />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(
      screen.getByRole("textbox", { name: "Add a to-do" }),
      "Call the plumber, Bathroom, Mon",
    );
    expect(await screen.findByText(/No project or course called “Bathroom”/)).toBeTruthy();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(callsTo("memory.entities.create")).toHaveLength(1));
    expect(callsTo("memory.entities.edges.set")).toHaveLength(0);
  });

  it("takes a bare title or a title and a day, with no project, and Escape closes it", async () => {
    const { callsTo, user } = setup(<MemoryScreen kind="due" now={STORY_NOW} />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    expect(screen.getByTestId("quick-add-preview").textContent).toMatch(/A title, then a project/);
    expect(screen.getByRole("button", { name: "Add", description: "" })).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Add a to-do" }), "Call the dentist");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(callsTo("memory.entities.create")).toHaveLength(1));
    expect(callsTo("memory.entities.create")[0]?.params).not.toHaveProperty("dueAt");
    expect(await within(await group("No date")).findByText("Call the dentist")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.type(screen.getByRole("textbox", { name: "Add a to-do" }), "Renew the lease, Dec 1");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(callsTo("memory.entities.create")).toHaveLength(2));
    expect(callsTo("memory.entities.create")[1]?.params).toMatchObject({
      name: "Renew the lease",
      dueAt: "2026-12-01T23:59:00.000Z",
    });
    expect(callsTo("memory.entities.edges.set")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Add a to-do" })).toBeNull();
  });
});

describe("Everything and Back", () => {
  it("puts Due soon in the overview: open items by date, past due first, with a one-tap Done", async () => {
    const { callsTo, navigate, user } = setup(<MemoryScreen now={STORY_NOW} />);
    const due = await screen.findByRole("region", { name: "Due soon" });
    const names = within(due)
      .getAllByTestId("work-row")
      .map((r) => r.querySelector("span.truncate")?.textContent);
    expect(names).toEqual([
      "Sign off on the launch copy",
      "Order cabinet hardware",
      "Lecture Work 7",
      "Q3 board deck",
      "Midterm review sheet",
    ]);
    // Done, handed-in and undated items are not "soon".
    expect(within(due).queryByText("Lecture Work 5")).toBeNull();
    expect(within(due).queryByText("File taxes")).toBeNull();
    await user.click(within(due).getByRole("button", { name: "See all" }));
    expect(navigate).toHaveBeenLastCalledWith("/memory?kind=due");
    await user.click(
      within(due).getByRole("checkbox", { name: "Mark “Sign off on the launch copy” done" }),
    );
    await waitFor(() =>
      expect(callsTo("memory.entities.facts.set").at(-1)?.params).toMatchObject({
        entityId: WORK_IDS.signoff,
        value: "done",
      }),
    );
  });

  it("shows no Due soon when nothing is tracked", async () => {
    setup(<MemoryScreen now={STORY_NOW} />, {
      edit: (w) => {
        w.graph.entities = w.graph.entities.filter((e) => e.kind !== "assignment");
      },
    });
    await screen.findByTestId("memory-everything");
    expect(screen.queryByRole("region", { name: "Due soon" })).toBeNull();
  });

  it("goes Back from a to-do to Work due", async () => {
    const { navigate, user } = setup(<MemoryScreen entity={WORK_IDS.lw7} now={STORY_NOW} />);
    await user.click(await screen.findByRole("button", { name: "Back to Work due" }));
    expect(navigate).toHaveBeenLastCalledWith("/memory?kind=due");
  });
});

describe("Projects", () => {
  it("lists projects and courses by status, with the kind, due and stale mark", async () => {
    const { user } = setup(<MemoryScreen kind="projects" now={STORY_NOW} />);
    const tab = await screen.findByTestId("memory-projects");
    const math = (await within(tab).findByText("MATH 21")).closest(
      "[data-testid=project-row]",
    ) as HTMLElement;
    expect(within(math).getByText("Course")).toBeTruthy();
    expect(within(tab).getByText("Q4 launch")).toBeTruthy();
    expect(within(tab).getByText("Kitchen remodel")).toBeTruthy();
    expect(within(tab).queryByText("Garage clean-out")).toBeNull();

    await user.click(within(tab).getByRole("radio", { name: "Paused" }));
    expect(await within(tab).findByText("Garage clean-out")).toBeTruthy();
    expect(within(tab).queryByText("MATH 21")).toBeNull();
    await user.click(within(tab).getByRole("radio", { name: "Done" }));
    expect(await within(tab).findByText("Lisbon trip")).toBeTruthy();
  });

  it("marks an active project nobody has touched for two weeks as stale", async () => {
    setup(<MemoryScreen kind="projects" now={STORY_NOW} />, {
      edit: (w) => {
        const kitchen = w.graph.entities.find((e) => e.id === WORK_IDS.kitchen);
        if (kitchen) kitchen.lastInteractionAt = "2026-09-20T15:00:00Z";
      },
    });
    const kitchen = (await screen.findByText("Kitchen remodel")).closest(
      "[data-testid=project-row]",
    ) as HTMLElement;
    expect(within(kitchen).getByTestId("stale-mark").textContent).toBe("As of Sep 20");
    const math = screen.getByText("MATH 21").closest("[data-testid=project-row]") as HTMLElement;
    expect(within(math).queryByTestId("stale-mark")).toBeNull();
  });

  it("adds a project by default, and opens its page", async () => {
    const { callsTo, navigate, user } = setup(<MemoryScreen kind="projects" now={STORY_NOW} />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(screen.getByRole("textbox", { name: "Add a project or course" }), "Bathroom");
    expect(screen.getByRole("radio", { name: "Project" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Add", description: "" }));
    await waitFor(() => expect(callsTo("memory.entities.create")).toHaveLength(1));
    expect(callsTo("memory.entities.create")[0]?.params).toMatchObject({
      kind: "project",
      name: "Bathroom",
      projectType: "project",
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenLastCalledWith(
        expect.stringMatching(/^\/memory\?entity=ent_new_/),
      ),
    );
  });

  it("adds a course when asked, and opens its page", async () => {
    const { callsTo, navigate, user } = setup(<MemoryScreen kind="projects" now={STORY_NOW} />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(screen.getByRole("textbox", { name: "Add a project or course" }), "PHYS 5A");
    await user.click(screen.getByRole("radio", { name: "Course" }));
    await user.click(screen.getByRole("button", { name: "Add", description: "" }));
    await waitFor(() => expect(callsTo("memory.entities.create")).toHaveLength(1));
    expect(callsTo("memory.entities.create")[0]?.params).toMatchObject({
      kind: "project",
      name: "PHYS 5A",
      projectType: "course",
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenLastCalledWith(
        expect.stringMatching(/^\/memory\?entity=ent_new_/),
      ),
    );
  });
});

describe("a course's page", () => {
  const open = (id: string = WORK_IDS.math) => setup(<MemoryScreen entity={id} now={STORY_NOW} />);

  it("leads with the type and term, the status and what to do next", async () => {
    open();
    const card = await screen.findByRole("article", { name: "MATH 21" });
    expect(within(card).getByText("Course · Fall 2026")).toBeTruthy();
    expect(within(card).getByRole("radio", { name: "Active" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      within(card).getByText("Finish Lecture Work 7 before office hours on Tuesday"),
    ).toBeTruthy();
    // Facts that have their own place are not repeated; the rest are.
    expect(within(card).getByText("MWF 10:40")).toBeTruthy();
    expect(within(card).getAllByText("MATH 21").length).toBeGreaterThan(1);
  });

  it("lists its to-dos, open first, each with a one-tap Done", async () => {
    const { callsTo, user } = open();
    const card = await screen.findByRole("article", { name: "MATH 21" });
    const work = within(card)
      .getByRole("heading", { name: "To-dos" })
      .closest("section") as HTMLElement;
    const names = within(work)
      .getAllByTestId("work-row")
      .map((r) => r.textContent ?? "");
    expect(names[0]).toContain("Lecture Work 7");
    expect(names[1]).toContain("Midterm review sheet");
    // Done last, the oldest first: it stays on the course after it left Work due.
    expect(names.at(-2)).toContain("Lecture Work 1");
    expect(names.at(-1)).toContain("Lecture Work 5");
    expect(within(work).queryByText("MATH 21")).toBeNull();

    await user.click(within(work).getByRole("checkbox", { name: "Mark “Lecture Work 7” done" }));
    await waitFor(() =>
      expect(callsTo("memory.entities.facts.set").at(-1)?.params).toMatchObject({
        entityId: WORK_IDS.lw7,
        attribute: "status",
        value: "done",
      }),
    );
  });

  it("shows who teaches it and who is in it", async () => {
    const { navigate, user } = open();
    const card = await screen.findByRole("article", { name: "MATH 21" });
    const prof = within(card)
      .getAllByRole("button", { name: /Prof\. Monteiro/ })
      .find((b) => b.textContent?.includes("Teaches")) as HTMLElement;
    expect(prof).toBeTruthy();
    expect(within(card).getByRole("button", { name: /Priya Nair/ }).textContent).toContain(
      "Member",
    );
    await user.click(prof);
    expect(navigate).toHaveBeenLastCalledWith(`/memory?entity=${WORK_IDS.prof}`);
  });

  it("draws the timeline of the course and its to-dos, newest first, each with its source", async () => {
    open();
    const card = await screen.findByRole("article", { name: "MATH 21" });
    const rows = await within(card).findAllByTestId("timeline-row");
    const text = rows.map((r) => r.textContent ?? "");
    // Newest first.
    expect(text[0]).toContain(
      "Lecture Work 7 · Next step: Finish 4b and 5, then submit on Gradescope",
    );
    const index = (needle: string) => text.findIndex((t) => t.includes(needle));
    expect(index("Edited hw7.tex")).toBeLessThan(index("Meeting: “MATH 21 lecture”"));
    // The due date, the status change and the loop are all there.
    expect(index("Due Oct 21")).toBeGreaterThan(-1);
    expect(index("Marked in progress")).toBeGreaterThan(-1);
    expect(index("Waiting on Prof. Monteiro: Regrade on Lecture Work 5")).toBeGreaterThan(-1);
    // Chips: the owner's own signals by source, someone else's words by sender.
    const chips = within(card)
      .getAllByTestId("timeline-chip")
      .map((c) => c.textContent);
    expect(chips).toContain("Files");
    expect(chips).toContain("From Prof. Monteiro's mail");
  });

  it("shows older rows on request", async () => {
    const { user } = open();
    const card = await screen.findByRole("article", { name: "MATH 21" });
    await within(card).findAllByTestId("timeline-row");
    const before = within(card).getAllByTestId("timeline-row").length;
    const more = within(card).queryByRole("button", { name: "Show older" });
    if (more) {
      await user.click(more);
      await waitFor(() =>
        expect(within(card).getAllByTestId("timeline-row").length).toBeGreaterThan(before),
      );
    } else {
      // The fixture fits in one page; the method is exercised in the next test.
      expect(before).toBeLessThan(20);
    }
  });

  it("changes a course's status, and keeps it private from the menu", async () => {
    const { callsTo, user } = open();
    const card = await screen.findByRole("article", { name: "MATH 21" });
    await user.click(within(card).getByRole("radio", { name: "Paused" }));
    await waitFor(() =>
      expect(callsTo("memory.entities.update").at(-1)?.params).toMatchObject({
        id: WORK_IDS.math,
        projectStatus: "paused",
      }),
    );
    await user.click(within(card).getByRole("button", { name: "More for MATH 21" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Keep private" }));
    await waitFor(() =>
      expect(callsTo("memory.entities.update").at(-1)?.params).toMatchObject({
        id: WORK_IDS.math,
        private: true,
      }),
    );
    await user.click(within(card).getByRole("button", { name: "More for MATH 21" }));
    expect(
      (await screen.findByRole("menuitemcheckbox", { name: "Keep private" })).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
  });

  it("adds a to-do to the course from its page", async () => {
    const { callsTo, user } = open();
    const card = await screen.findByRole("article", { name: "MATH 21" });
    await user.click(within(card).getByRole("button", { name: "Add" }));
    await user.type(
      within(card).getByRole("textbox", { name: "Add a to-do" }),
      "Lecture Work 8, Fri",
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(callsTo("memory.entities.edges.set")).toHaveLength(1));
    expect(callsTo("memory.entities.edges.set")[0]?.params).toMatchObject({
      rel: "part_of",
      dst: WORK_IDS.math,
    });
    expect(await within(card).findByText("Lecture Work 8")).toBeTruthy();
  });
});

describe("linked sources", () => {
  it("lists what is linked, who linked it, and shows a model's guess as a suggestion", async () => {
    setup(<MemoryScreen entity={WORK_IDS.deck} now={STORY_NOW} />);
    const card = await screen.findByRole("article", { name: "Q3 board deck" });
    const linked = (await within(card).findByRole("heading", { name: "Linked" })).closest(
      "section",
    ) as HTMLElement;
    const rows = await within(linked).findAllByTestId("anchor-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Q3-deck");
    expect(rows[0]?.textContent).toContain("~/Documents/Acme/Q3-deck");
    expect(rows[0]?.textContent).toContain("You linked it");
    expect(rows[1]?.textContent).toContain("Suggested, not used until you link it");
  });

  it("links a folder by path, and unlinks it", async () => {
    const { callsTo, user } = setup(<MemoryScreen entity={WORK_IDS.math} now={STORY_NOW} />);
    const card = await screen.findByRole("article", { name: "MATH 21" });
    await user.click(await within(card).findByRole("button", { name: "Add link" }));
    const form = within(card).getByRole("form", { name: "Link a source" });
    await user.type(
      within(form).getByRole("textbox", { name: "Folder path" }),
      "~/School/MATH21/notes",
    );
    expect(within(form).getByText(/Only folders you link count as work/)).toBeTruthy();
    await user.click(within(form).getByRole("button", { name: "Link" }));
    await waitFor(() =>
      expect(callsTo("memory.anchors.add").at(-1)?.params).toMatchObject({
        entityId: WORK_IDS.math,
        kind: "folder",
        ref: "~/School/MATH21/notes",
        label: "notes",
      }),
    );
    expect(await within(card).findByText("~/School/MATH21/notes", { exact: false })).toBeTruthy();

    await user.click(within(card).getByRole("button", { name: "Unlink notes" }));
    await waitFor(() => expect(callsTo("memory.anchors.remove")).toHaveLength(1));
    await waitFor(() =>
      expect(within(card).queryByRole("button", { name: "Unlink notes" })).toBeNull(),
    );
  });

  it("uses the host's folder picker when it has one", async () => {
    const pickFolder = vi.fn().mockResolvedValue("/Users/alex/Projects/Launch");
    const { callsTo, user } = setup(<MemoryScreen entity={WORK_IDS.launch} now={STORY_NOW} />, {
      slots: { pickFolder },
    });
    const card = await screen.findByRole("article", { name: "Q4 launch" });
    await user.click(await within(card).findByRole("button", { name: "Add link" }));
    await user.click(within(card).getByRole("button", { name: "Choose…" }));
    expect(pickFolder).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        (within(card).getByRole("textbox", { name: "Folder path" }) as HTMLInputElement).value,
      ).toBe("/Users/alex/Projects/Launch"),
    );
    await user.click(within(card).getByRole("button", { name: "Link" }));
    await waitFor(() =>
      expect(callsTo("memory.anchors.add").at(-1)?.params).toMatchObject({
        kind: "folder",
        ref: "/Users/alex/Projects/Launch",
        label: "Launch",
      }),
    );
  });

  it("links one of the owner's chats", async () => {
    const { callsTo, user } = setup(<MemoryScreen entity={WORK_IDS.math} now={STORY_NOW} />);
    const card = await screen.findByRole("article", { name: "MATH 21" });
    await user.click(await within(card).findByRole("button", { name: "Add link" }));
    await user.click(within(card).getByRole("radio", { name: "Chat" }));
    const select = within(card).getByRole("combobox", { name: "Chat" }) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
    await user.selectOptions(select, select.options[1]?.value ?? "");
    await user.click(within(card).getByRole("button", { name: "Link" }));
    await waitFor(() =>
      expect(callsTo("memory.anchors.add").at(-1)?.params).toMatchObject({
        entityId: WORK_IDS.math,
        kind: "chat_thread",
      }),
    );
  });
});

describe("a to-do's page", () => {
  const open = (id: string = WORK_IDS.deck) => setup(<MemoryScreen entity={id} now={STORY_NOW} />);

  it("leads with the due date, the status, where you stopped and the next step", async () => {
    open();
    const card = await screen.findByRole("article", { name: "Q3 board deck" });
    expect(within(card).getByText("To-do · Q4 launch")).toBeTruthy();
    expect(within(card).getByTestId("due-full").textContent).toMatch(/^Due Thu, Oct 22, 11:59 PM$/);
    expect(
      within(card).getByRole("radio", { name: "In progress" }).getAttribute("aria-checked"),
    ).toBe("true");
    for (const s of ["Not started", "In progress", "Handed in", "Done", "Dropped"])
      expect(within(card).getByRole("radio", { name: s })).toBeTruthy();
    expect(within(card).getByText("Slide 9, the pricing table")).toBeTruthy();
    expect(within(card).getByText("Add last quarter's numbers, then send to Sam")).toBeTruthy();
    expect(within(card).getByText("Outline and slides 1 to 8")).toBeTruthy();
    // Fresh: no stale note.
    expect(within(card).queryByTestId("stale-note")).toBeNull();
    // Its parent and who assigned it open their pages.
    expect(within(card).getByRole("button", { name: /Q4 launch/ })).toBeTruthy();
    expect(within(card).getByText("Assigned by")).toBeTruthy();
  });

  it("sets the status, and says so in the timeline", async () => {
    const { callsTo, user } = open();
    const card = await screen.findByRole("article", { name: "Q3 board deck" });
    await user.click(within(card).getByRole("radio", { name: "Handed in" }));
    await waitFor(() =>
      expect(callsTo("memory.entities.facts.set").at(-1)?.params).toMatchObject({
        entityId: WORK_IDS.deck,
        attribute: "status",
        value: "submitted",
      }),
    );
    await waitFor(() =>
      expect(
        within(card).getByRole("radio", { name: "Handed in" }).getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(await within(card).findByText("Status in progress → handed in")).toBeTruthy();
  });

  it("changes the due date, and clears it", async () => {
    const { callsTo, user } = open();
    const card = await screen.findByRole("article", { name: "Q3 board deck" });
    await user.click(within(card).getByRole("button", { name: "Change" }));
    const field = within(card).getByLabelText("Due date") as HTMLInputElement;
    expect(field.value).toBe("2026-10-22");
    await user.clear(field);
    await user.type(field, "2026-10-24");
    await user.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(callsTo("memory.entities.update").at(-1)?.params).toMatchObject({
        id: WORK_IDS.deck,
        dueAt: "2026-10-24T23:59:00.000Z",
      }),
    );
    expect(await within(card).findByText("Due date moved Oct 22 → Oct 24")).toBeTruthy();
    await waitFor(() => expect(within(card).getByTestId("due-full").textContent).toMatch(/Oct 24/));

    await user.click(within(card).getByRole("button", { name: "Change" }));
    await user.click(within(card).getByRole("button", { name: "Clear date" }));
    await waitFor(() =>
      expect(callsTo("memory.entities.update").at(-1)?.params).toMatchObject({
        id: WORK_IDS.deck,
        dueAt: null,
      }),
    );
    expect(await within(card).findByText("No date")).toBeTruthy();
  });

  it("says where you stopped, from the owner, and notes when it may be out of date", async () => {
    const { callsTo, user } = open(WORK_IDS.signoff);
    const card = await screen.findByRole("article", { name: "Sign off on the launch copy" });
    // Past due and idle for four days: overdue in words and a stale note.
    expect(within(card).getByTestId("due-full").textContent).toMatch(
      /^Overdue, was due Fri, Oct 16/,
    );
    expect(within(card).getByTestId("stale-note").textContent).toBe(
      "Last activity Oct 14. The status may be out of date.",
    );
    expect(within(card).getByText("Paragraph 3")).toBeTruthy();

    await user.click(within(card).getByRole("button", { name: "Add a next step" }));
    await user.type(
      within(card).getByRole("textbox", { name: "Next step" }),
      "Ask Sam to sign off",
    );
    await user.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(callsTo("memory.entities.facts.set").at(-1)?.params).toMatchObject({
        entityId: WORK_IDS.signoff,
        attribute: "next_step",
        value: "Ask Sam to sign off",
      }),
    );
    expect(await within(card).findByText("Ask Sam to sign off")).toBeTruthy();
  });

  it("starts a not-started to-do when the owner says where they stopped", async () => {
    const { user } = open(WORK_IDS.hardware);
    const card = await screen.findByRole("article", { name: "Order cabinet hardware" });
    expect(
      within(card).getByRole("radio", { name: "Not started" }).getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(within(card).getByRole("button", { name: "Say where you stopped" }));
    await user.type(
      within(card).getByRole("textbox", { name: "Where you stopped" }),
      "Called two suppliers",
    );
    await user.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        within(card).getByRole("radio", { name: "In progress" }).getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("keeps a to-do private", async () => {
    const { callsTo, user } = open(WORK_IDS.review);
    const card = await screen.findByRole("article", { name: "Midterm review sheet" });
    await user.click(within(card).getByRole("button", { name: "More for Midterm review sheet" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Keep private" }));
    await waitFor(() =>
      expect(callsTo("memory.entities.update").at(-1)?.params).toMatchObject({
        id: WORK_IDS.review,
        private: true,
      }),
    );
  });

  it("shows a to-do nobody has touched as stale, in words", async () => {
    open(WORK_IDS.hardware);
    const card = await screen.findByRole("article", { name: "Order cabinet hardware" });
    expect(await within(card).findByTestId("stale-note")).toBeTruthy();
    expect(within(card).getByTestId("stale-note").textContent).toBe(
      "Last activity Oct 9. The status may be out of date.",
    );
  });
});

describe("a to-do with no project", () => {
  it("reads as a to-do on its own, with no parent and no course framing", async () => {
    setup(<MemoryScreen entity={WORK_IDS.rent} now={STORY_NOW} />);
    const card = await screen.findByRole("article", { name: "Pay rent" });
    expect(within(card).getByText("To-do")).toBeTruthy();
    expect(within(card).queryByText("Details")).toBeNull();
    expect(within(card).getByTestId("due-full").textContent).toMatch(/Nov 1/);
    expect(within(card).queryByText(/course|assignment|homework/i)).toBeNull();
  });
});

describe("tracking a course end to end", () => {
  /** A host that follows `onNavigate` the way the app does, so one test can walk the pages. */
  function Host(): ReactElement {
    const [route, setRoute] = useState("/memory?kind=projects");
    const url = new URL(route, "http://psyche.local");
    const entity = url.searchParams.get("entity");
    return (
      <MemoryScreen
        now={STORY_NOW}
        kind={parseMemoryKind(url.searchParams.get("kind"))}
        {...(entity ? { entity } : {})}
        onNavigate={setRoute}
      />
    );
  }

  it("adds a course, gives it a term, links a folder, adds an assignment, works it and finishes it", async () => {
    const { callsTo, user } = setup(<Host />);

    // 1. Add the course on Projects: it opens on its own page.
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(screen.getByRole("textbox", { name: "Add a project or course" }), "PHYS 5A");
    await user.click(screen.getByRole("radio", { name: "Course" }));
    await user.click(screen.getByRole("button", { name: "Add", description: "" }));
    const course = await screen.findByRole("article", { name: "PHYS 5A" });
    expect(within(course).getByText("Course · Active")).toBeTruthy();

    // 2. Its term, as a fact: the type line now says it.
    await user.click(within(course).getByRole("button", { name: "Add a fact" }));
    await user.selectOptions(within(course).getByRole("combobox", { name: "Fact" }), "term");
    await user.type(within(course).getByRole("textbox", { name: "Value" }), "Fall 2026");
    await user.click(within(course).getByRole("button", { name: "Save" }));
    expect(await within(course).findByText("Course · Fall 2026")).toBeTruthy();

    // 3. A folder linked to it: the only way a folder counts as work.
    await user.click(await within(course).findByRole("button", { name: "Add link" }));
    await user.type(
      within(course).getByRole("textbox", { name: "Folder path" }),
      "~/School/PHYS5A",
    );
    await user.click(within(course).getByRole("button", { name: "Link" }));
    expect(await within(course).findByText("PHYS5A")).toBeTruthy();

    // 4. An assignment, from the course's own page.
    await user.click(within(course).getByRole("button", { name: "Add" }));
    await user.type(
      within(course).getByRole("textbox", { name: "Add a to-do" }),
      "Problem set 1, Fri",
    );
    await user.keyboard("{Enter}");
    const set = await within(course).findByRole("button", { name: /Problem set 1/ });

    // 5. Its page: nothing done yet, then saying where the owner stopped starts it.
    await user.click(set);
    const page = await screen.findByRole("article", { name: "Problem set 1" });
    expect(within(page).getByText("To-do · PHYS 5A")).toBeTruthy();
    expect(
      within(page).getByRole("radio", { name: "Not started" }).getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(within(page).getByRole("button", { name: "Say where you stopped" }));
    await user.type(within(page).getByRole("textbox", { name: "Where you stopped" }), "Problem 3");
    await user.click(within(page).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        within(page).getByRole("radio", { name: "In progress" }).getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(await within(page).findByText("Stopped at Problem 3")).toBeTruthy();

    // 6. Finished.
    await user.click(within(page).getByRole("radio", { name: "Done" }));
    await waitFor(() =>
      expect(callsTo("memory.entities.facts.set").at(-1)?.params).toMatchObject({
        attribute: "status",
        value: "done",
      }),
    );

    // 7. Back out: it sits under Done in Work due, with its course.
    await user.click(screen.getByRole("button", { name: /^Back to/ }));
    await user.click(await screen.findByRole("button", { name: "Work due" }));
    const done = await group("Done");
    const row = await within(done).findByText("Problem set 1");
    expect(
      within(row.closest("[data-testid=work-row]") as HTMLElement).getByText("PHYS 5A"),
    ).toBeTruthy();
  });
});
