import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatThread } from "../src/chat/Thread.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { SHORTCUTS } from "../src/shell/shortcuts.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

const NOW = Date.parse(FIXTURE_NOW);
const NOTICE = "Private chat: not kept in memory or search, and deleted after 24 hours.";

function renderThread(threadId: string) {
  const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  return render(
    <GatewayProvider client={gateway} store={store}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
        <ChatThread threadId={threadId} now={NOW} />
      </UiSlotsProvider>
    </GatewayProvider>,
  );
}

describe("incognito indicator on the thread", () => {
  it("shows the one-line explainer in an incognito chat", async () => {
    renderThread(IDS.threads.incognito);
    expect(await screen.findByRole("note")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toBe(NOTICE);
  });

  it("positive control: a normal chat shows no incognito notice", async () => {
    renderThread(IDS.threads.dentist);
    expect(await screen.findByRole("log", { name: "Conversation" })).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("incognito shortcut in the shell map", () => {
  const event = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    ({
      key,
      code: `Key${key.toUpperCase()}`,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...mods,
    }) as unknown as KeyboardEvent;

  it("Mod+Shift+N matches the incognito entry; plain Mod+N still matches new side chat", () => {
    const find = (id: string) => SHORTCUTS.find((s) => s.id === id);
    expect(
      find("newIncognitoChat")?.match(event("N", { metaKey: true, shiftKey: true }), true),
    ).toBe(true);
    expect(find("newIncognitoChat")?.match(event("n", { metaKey: true }), true)).toBe(false);
    expect(find("newSideChat")?.match(event("n", { metaKey: true }), true)).toBe(true);
    expect(find("newSideChat")?.match(event("N", { metaKey: true, shiftKey: true }), true)).toBe(
      false,
    );
  });
});
