import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  type ArgContext,
  type ArgOption,
  filterOptions,
  memoizeOptions,
  modeOptions,
} from "../src/chat/command-args.ts";
import { ChatThread } from "../src/chat/Thread.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { sampleModelProviders, sampleModelRoles } from "../src/screens/settings/sample-data.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

const NOW = Date.parse(FIXTURE_NOW);

/** A thread whose `models.list` is the settings sample plus a hosted provider without a key. */
function renderMain() {
  const world = createFixtureWorld();
  world.modelProviders = [
    ...sampleModelProviders(),
    {
      id: "openai",
      kind: "openai",
      label: "OpenAI",
      local: false,
      keyConfigured: false,
      models: [{ ref: "openai/gpt-5.5", toolCheck: "agent-capable" }],
      probe: { state: "not_probed", models: [] },
    },
  ];
  world.modelRoles = sampleModelRoles();
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
const popup = (command: string) => screen.findByRole("listbox", { name: `Values for /${command}` });
const updates = (gateway: MockGateway) =>
  gateway.calls.filter((c) => c.method === "threads.update").map((c) => c.params);

describe("argument popup (/model)", () => {
  it("lists the models from models.list with their provider and badges, current marked", async () => {
    renderMain();
    await userEvent.type(await box(), "/model ");
    const list = await screen.findByRole("listbox", { name: "Values for /model" });
    await waitFor(() => expect(within(list).getAllByRole("option").length).toBeGreaterThan(1));
    const sonnet = within(list).getByRole("option", { name: /claude-sonnet-5-5/ });
    expect(sonnet.textContent).toContain("Anthropic");
    expect(sonnet.textContent).toContain("Vision");
    // The thread follows the primary role, so that is the current value.
    expect(within(sonnet).getByText("current")).toBeTruthy();
    // A model that cannot be used is listed, greyed, with the reason.
    const gpt = within(list).getByRole("option", { name: /gpt-5.5/ });
    expect(gpt.getAttribute("aria-disabled")).toBe("true");
    expect(gpt.textContent).toContain("No API key");
    // The input points at the highlighted row.
    const active = (await box()).getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    expect(document.getElementById(active as string)?.getAttribute("aria-selected")).toBe("true");
  });

  it("filters as the owner types and Return picks the value and runs the command", async () => {
    const { gateway } = renderMain();
    await userEvent.type(await box(), "/model ");
    await waitFor(async () =>
      expect(within(await popup("model")).getAllByRole("option").length).toBeGreaterThan(1),
    );
    await userEvent.keyboard("tiny");
    const list = await popup("model");
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("This thread now uses llamacpp/tiny-chat.")).toBeTruthy();
    expect(updates(gateway)).toEqual([
      { threadId: IDS.threads.main, modelRef: "llamacpp/tiny-chat" },
    ]);
    expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(false);
    expect(screen.queryByRole("listbox", { name: "Values for /model" })).toBeNull();
  });

  it("moves with the arrow keys past values that cannot be used, and a click picks", async () => {
    const { gateway } = renderMain();
    await userEvent.type(await box(), "/model ");
    const list = await popup("model");
    await waitFor(() => expect(within(list).getAllByRole("option").length).toBeGreaterThan(2));
    const options = () => within(list).getAllByRole("option");
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    // Up from the first wraps past the greyed row.
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(options().find((o) => o.getAttribute("aria-selected") === "true")).toBeTruthy();
    expect(
      options()
        .find((o) => o.getAttribute("aria-selected") === "true")
        ?.getAttribute("aria-disabled"),
    ).toBeNull();
    // Clicking a greyed row does nothing; an enabled one runs.
    await userEvent.click(within(list).getByRole("option", { name: /gpt-5.5/ }));
    expect(updates(gateway)).toEqual([]);
    await userEvent.click(within(list).getByRole("option", { name: /tiny-chat/ }));
    await waitFor(() => expect(updates(gateway)).toHaveLength(1));
  });

  it("Escape closes the popup, and a value typed in full is sent by Return as before", async () => {
    const { gateway } = renderMain();
    await userEvent.type(await box(), "/model ");
    await popup("model");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Values for /model" })).toBeNull();
    expect((await box()).value).toBe("/model ");
    await userEvent.keyboard("anthropic/claude-sonnet-5-5");
    // Complete value: nothing left to complete, Return runs it.
    expect(screen.queryByRole("listbox", { name: "Values for /model" })).toBeNull();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(updates(gateway)).toEqual([
        { threadId: IDS.threads.main, modelRef: "anthropic/claude-sonnet-5-5" },
      ]),
    );
  });

  it("shows no popup when nothing matches, so Return reports the usage as it did", async () => {
    renderMain();
    await userEvent.type(await box(), "/model zzz");
    expect(screen.queryByRole("listbox", { name: "Values for /model" })).toBeNull();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText(/^Usage: \/model/)).toBeTruthy();
  });
});

describe("argument popup (other commands)", () => {
  it("/mode lists the permission modes with a description and sets the one picked", async () => {
    const { gateway } = renderMain();
    await userEvent.type(await box(), "/mode ");
    const list = await popup("mode");
    const rows = within(list).getAllByRole("option");
    expect(rows).toHaveLength(4);
    for (const [i, mode] of ["manual", "balanced", "auto", "plan"].entries()) {
      expect(rows[i]?.textContent?.startsWith(mode)).toBe(true);
    }
    expect(within(list).getByRole("option", { name: /balanced/ }).textContent).toContain(
      "Asks only for risky actions",
    );
    await userEvent.keyboard("pl{Tab}");
    expect(await screen.findByText("Permission mode is now plan.")).toBeTruthy();
    expect(updates(gateway)).toEqual([{ threadId: IDS.threads.main, permissionMode: "plan" }]);
  });

  it("/export offers its formats", async () => {
    renderMain();
    await userEvent.type(await box(), "/export ");
    const list = await popup("export");
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("a free-text command shows no popup", async () => {
    renderMain();
    await userEvent.type(await box(), "/remember ");
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.type(await box(), "I prefer aisle");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((await box()).value).toBe("/remember I prefer aisle");
  });
});

describe("argument sources", () => {
  const options: ArgOption[] = [
    { value: "anthropic/claude-sonnet-5-5", label: "claude-sonnet-5-5", detail: "Anthropic" },
    { value: "openai/gpt-5.5", label: "gpt-5.5", detail: "OpenAI" },
    { value: "sonnet-local", detail: "Local" },
  ];

  it("filters by prefix first, then anywhere in the value, label or detail", () => {
    expect(filterOptions(options, "").map((o) => o.value)).toHaveLength(3);
    expect(filterOptions(options, "son").map((o) => o.value)).toEqual([
      "sonnet-local",
      "anthropic/claude-sonnet-5-5",
    ]);
    expect(filterOptions(options, "openai").map((o) => o.value)).toEqual(["openai/gpt-5.5"]);
    expect(filterOptions(options, "nothing")).toEqual([]);
  });

  it("greys Auto when the thread's model is known not to be Auto-capable", () => {
    const providers = sampleModelProviders();
    const model = providers[0]?.models[0] as { autoMode?: boolean };
    const ctx = (autoMode: boolean | undefined): ArgContext => {
      if (autoMode === undefined) model.autoMode = undefined;
      else model.autoMode = autoMode;
      return {
        models: { providers, roles: sampleModelRoles() },
        modelRef: null,
        permissionMode: "balanced",
      };
    };
    const auto = (c: ArgContext) => modeOptions(c).find((o) => o.value === "auto");
    expect(auto(ctx(false))?.disabledReason).toContain("Auto-capable");
    expect(auto(ctx(true))?.disabledReason).toBeUndefined();
    // Not reported (an older Gateway): never blocks.
    expect(auto(ctx(undefined))?.disabledReason).toBeUndefined();
  });

  it("memoizes an async source and retries after a failure", async () => {
    let calls = 0;
    const source = memoizeOptions(async () => {
      calls++;
      if (calls === 1) throw new Error("down");
      return options;
    });
    await expect(source()).rejects.toThrow("down");
    await Promise.resolve();
    expect(await source()).toBe(options);
    expect(await source()).toBe(options);
    expect(calls).toBe(2);
  });
});
