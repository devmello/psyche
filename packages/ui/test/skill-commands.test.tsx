import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { COMMANDS, matchMenu, type SkillMenuItem, skillCompletion } from "../src/chat/commands.ts";
import { ChatThread } from "../src/chat/Thread.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

const NOW = Date.parse(FIXTURE_NOW);

const item = (name: string, description = `${name} does things`): SkillMenuItem => ({
  name,
  description,
});

describe("skills in the slash menu: merge, order, filter, clash", () => {
  it("lists built-ins first, then skills sorted by name", () => {
    const got = matchMenu("/", [item("weekly-review"), item("inbox-triage"), item("apps")]);
    expect(got.commands.map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
    expect(got.skills.map((s) => s.name)).toEqual(["apps", "inbox-triage", "weekly-review"]);
  });

  it("filters both lists by the prefix typed, with digits and hyphens", () => {
    const skills = [item("inbox-triage"), item("inbox-2"), item("weekly-review")];
    const got = matchMenu("/inb", skills);
    expect(got.commands).toEqual([]);
    expect(got.skills.map((s) => s.name)).toEqual(["inbox-2", "inbox-triage"]);
    expect(matchMenu("/inbox-t", skills).skills.map((s) => s.name)).toEqual(["inbox-triage"]);
    expect(matchMenu("/zzz", skills)).toEqual({ commands: [], skills: [] });
  });

  it("keeps the built-in when a skill has the same name, and drops the skill row", () => {
    const got = matchMenu("/cl", [item("clear"), item("clean-up")]);
    expect(got.commands.map((c) => c.name)).toEqual(["clear"]);
    expect(got.skills.map((s) => s.name)).toEqual(["clean-up"]);
    const all = matchMenu("/", [item("clear"), item("stop")]);
    expect(all.skills).toEqual([]);
  });

  it("skips names the $name reference cannot carry and repeated names", () => {
    const got = matchMenu("/", [
      item("Inbox Triage"),
      item("under_score"),
      item("-lead"),
      item("ok-one"),
      item("ok-one", "second copy"),
    ]);
    expect(got.skills.map((s) => s.name)).toEqual(["ok-one"]);
    expect(got.skills[0]?.description).toBe("ok-one does things");
  });

  it("shows nothing for text that is not a bare slash prefix", () => {
    expect(matchMenu("hi /inb", [item("inbox")])).toEqual({ commands: [], skills: [] });
    expect(matchMenu("/inbox x", [item("inbox")])).toEqual({ commands: [], skills: [] });
  });

  it("inserts $name and a space when a skill is chosen", () => {
    expect(skillCompletion(item("inbox-triage"))).toBe("$inbox-triage ");
  });
});

function renderThread(setup: (world: ReturnType<typeof createFixtureWorld>) => void = () => {}) {
  const world = createFixtureWorld();
  // The fixture's `inbox-triage` is enabled and user-invocable; `clear` clashes with a built-in.
  world.skills = [
    ...world.skills,
    {
      ...(world.skills.find((s) => s.name === "inbox-triage") as (typeof world.skills)[number]),
      name: "clear",
      description: "A skill that shares the built-in name",
    },
  ];
  setup(world);
  const gateway = new MockGateway(world, { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  render(
    <GatewayProvider client={gateway} store={store}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
        <ChatThread threadId={IDS.threads.main} now={NOW} />
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  return { gateway };
}

const box = () =>
  screen.findByRole("textbox", { name: "Message Wren" }) as Promise<HTMLTextAreaElement>;
const commandsList = () => screen.findByRole("listbox", { name: "Commands" });

describe("skills in the composer's slash menu", () => {
  it("fetches skills.commands once the owner types a slash and shows them under Skills", async () => {
    const { gateway } = renderThread();
    await userEvent.type(await box(), "/");
    const list = await commandsList();
    await waitFor(() =>
      expect(within(list).getByRole("option", { name: /inbox-triage/ })).toBeDefined(),
    );
    const heading = within(list).getByText("Skills");
    const builtinRow = within(list).getByRole("option", { name: /\/stop/ });
    const skillRow = within(list).getByRole("option", { name: /inbox-triage/ });
    // Built-ins first, then the heading, then the skill.
    expect(builtinRow.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(heading.compareDocumentPosition(skillRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(skillRow.textContent).toContain("Sort today's mail");
    // The clashing skill is not listed; the built-in /clear is.
    expect(within(list).getAllByRole("option", { name: /\/clear/ })).toHaveLength(1);
    expect(within(list).queryByRole("option", { name: /A skill that shares/ })).toBeNull();
    // Disabled and non-invocable skills never appear: the fixture's calendar skill is disabled.
    expect(within(list).queryByRole("option", { name: /calendar-planning/ })).toBeNull();
    expect(gateway.calls.filter((c) => c.method === "skills.commands")).toHaveLength(1);
  });

  it("filters the skills as the owner types and sends $name with the message on pick", async () => {
    const { gateway } = renderThread();
    const input = await box();
    await userEvent.type(input, "/inb");
    const list = await commandsList();
    await waitFor(() =>
      expect(within(list).getByRole("option", { name: /inbox-triage/ })).toBeDefined(),
    );
    expect(within(list).queryByRole("option", { name: /incognito/ })).toBeNull();
    await userEvent.click(within(list).getByRole("option", { name: /inbox-triage/ }));
    expect(input.value).toBe("$inbox-triage ");
    await userEvent.type(input, "triage today{Enter}");
    await waitFor(() => expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(true));
    expect(gateway.calls.find((c) => c.method === "chat.send")?.params).toMatchObject({
      content: "$inbox-triage triage today",
    });
  });

  it("shows built-ins only, with no error, when skills.commands fails", async () => {
    const { gateway } = renderThread();
    gateway.failNext("skills.commands", "unavailable", "the Gateway is busy");
    await userEvent.type(await box(), "/");
    const list = await commandsList();
    await waitFor(() => expect(within(list).getByRole("option", { name: /\/stop/ })).toBeDefined());
    expect(within(list).queryByText("Skills")).toBeNull();
    expect(within(list).queryByRole("option", { name: /inbox-triage/ })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows built-ins only when the Gateway has no skills", async () => {
    renderThread((world) => {
      world.skills = [];
    });
    await userEvent.type(await box(), "/");
    const list = await commandsList();
    await waitFor(() => expect(within(list).getByRole("option", { name: /\/stop/ })).toBeDefined());
    expect(within(list).queryByText("Skills")).toBeNull();
    expect(within(list).getAllByRole("option")).toHaveLength(COMMANDS.length);
  });
});
