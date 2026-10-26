import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ReactElement, useState } from "react";
import { describe, expect, it } from "vitest";
import { ChatThread } from "../src/chat/Thread.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { appleConnectors, createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { ConnectorsSection } from "../src/screens/settings/ConnectorsSection.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";

const NOW = Date.parse(FIXTURE_NOW);

/** Settings → Connectors with the Apple apps, and the chat it opens for "Try it". */
function setup() {
  const world = createFixtureWorld();
  world.connectors = appleConnectors();
  const gateway = new MockGateway(world, { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  const routes: string[] = [];
  function Host(): ReactElement {
    const [route, setRoute] = useState("/settings/connectors");
    const navigate = (to: string) => {
      routes.push(to);
      setRoute(to);
    };
    return (
      <UiSlotsProvider value={{ navigate, persona: { name: "Wren", creature: "moth" } }}>
        {route === "/chat" ? (
          <ChatThread threadId={IDS.threads.main} now={NOW} />
        ) : (
          <ConnectorsSection now={NOW} />
        )}
      </UiSlotsProvider>
    );
  }
  render(
    <GatewayProvider client={gateway} store={store}>
      <Host />
    </GatewayProvider>,
  );
  const settingsWrites = () =>
    gateway.calls.filter((c) => c.method === "settings.set").map((c) => c.params);
  return { gateway, routes, settingsWrites };
}

async function openCard(name: string) {
  const card = await screen.findByRole("article", { name });
  await userEvent.click(within(card).getByRole("button", { name: "What Wren can do" }));
  return card;
}

describe("Apple app capability cards (docs/connectors/apple-apps-2026.md §7.1, #640)", () => {
  it("lists Mail's action groups in plain words, and Send never offers Allow", async () => {
    const { settingsWrites } = setup();
    const card = await openCard("Apple Mail");
    const groups = within(card).getByRole("list", { name: "What Wren can do with Apple Mail" });
    const rows = within(groups).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector("span")?.textContent)).toEqual([
      "Read mail",
      "Draft mail",
      "Organize mail",
      "Send mail",
    ]);
    expect(within(groups).getByText(/See unread counts per mailbox/)).toBeTruthy();
    // Raw keys stay out of the first level.
    expect(within(card).queryByText("mail.organize")).toBeNull();

    const send = within(groups).getByRole("radiogroup", { name: "Send mail" });
    expect(within(send).queryByRole("radio", { name: /Allow/ })).toBeNull();
    expect(within(groups).getByText("Always asks first")).toBeTruthy();

    // A group's rule is the matrix override the Permissions section reads.
    const organize = within(groups).getByRole("radiogroup", { name: "Organize mail" });
    await userEvent.click(within(organize).getByRole("radio", { name: "Organize mail: Deny" }));
    await waitFor(() =>
      expect(settingsWrites()).toContainEqual({
        key: `permissions.connectors.${IDS.connectors.appleMail}`,
        value: expect.objectContaining({ "mail.organize": "deny", "mail.read": "allow" }),
      }),
    );
  });

  it("names the macOS grant each app uses, and the path to fix a missing one", async () => {
    setup();
    const mail = await openCard("Apple Mail");
    expect(
      within(mail).getByText("Allowed in System Settings → Privacy & Security → Automation → Mail"),
    ).toBeTruthy();
    const calendar = await openCard("Apple Calendar");
    expect(
      within(calendar).getByText("Allowed in System Settings → Privacy & Security → Calendars"),
    ).toBeTruthy();
    // Notes waits on its Automation grant: the existing notice names the path, no "Allowed".
    const notes = await openCard("Apple Notes");
    expect(within(notes).getByText(/Automation → Psyche \(Helper\) → Notes/)).toBeTruthy();
    expect(within(notes).queryByText(/^Allowed in System Settings/)).toBeNull();
    // Not connected yet: nothing to try.
    expect(within(notes).queryByRole("button", { name: /Find my note/ })).toBeNull();
  });

  it("leaves write groups off for a read-only connection", async () => {
    setup();
    const reminders = await openCard("Apple Reminders");
    expect(
      within(reminders).getByText("Off while Apple Reminders is connected read-only"),
    ).toBeTruthy();
    expect(within(reminders).queryByRole("radiogroup", { name: "Change reminders" })).toBeNull();
    expect(within(reminders).getByRole("radiogroup", { name: "Read reminders" })).toBeTruthy();
  });

  it("fills the chat composer with a Try it request", async () => {
    const { routes, gateway } = setup();
    const mail = await openCard("Apple Mail");
    await userEvent.click(within(mail).getByRole("button", { name: "What's unread from today?" }));
    expect(routes).toEqual(["/chat"]);
    const box = (await screen.findByRole("textbox", {
      name: "Message Wren",
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("What's unread from today?"));
    // Filled, not sent.
    expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(false);
  });
});
