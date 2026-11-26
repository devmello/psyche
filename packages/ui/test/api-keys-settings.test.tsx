import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import { checkApiKeyDraft } from "../src/screens/settings/ApiKeysSettings.tsx";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import {
  sampleEndpointProbes,
  sampleModelProviders,
  sampleModelRoles,
  sampleSettings,
} from "../src/screens/settings/sample-data.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings → Model & providers → API keys: write-only keys (setup without a terminal). */

function setup(): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld
      edit={(w) => {
        Object.assign(w.settings, sampleSettings());
        w.modelProviders = sampleModelProviders();
        w.modelRoles = sampleModelRoles();
        w.modelProbes = sampleEndpointProbes();
      }}
      onGateway={(g) => {
        gw = g;
      }}
    >
      <SettingsScreen now={Date.parse(FIXTURE_NOW)} defaultSection="model" />
    </StoryWorld>,
  );
  return () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw;
  };
}

/** A key lives behind its row: the row opens a small sheet with the field, Save and Clear. */
async function openKey(id: string): Promise<HTMLElement> {
  await userEvent.click(await screen.findByTestId(`api-key-row-${id}`));
  return await screen.findByTestId(`api-key-${id}`);
}

const callsOf = (g: MockGateway, method: string) => g.calls.filter((c) => c.method === method);
const SECRET = "sk-ant-api03-UISECRETVALUE";

describe("checkApiKeyDraft", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["sk-ant-abc", null],
    ["  sk-ant-abc  ", null],
    ["sk ant", "whitespace"],
    ["sk-ant\nabc", "whitespace"],
  ] as const)("%j -> %s", (input, expected) => {
    expect(checkApiKeyDraft(input)).toBe(expected);
  });
});

describe("API keys section", () => {
  it("has a row per provider and web search; each opens a sheet with a password field", async () => {
    setup();
    const ids = ["anthropic", "openai", "google", "openrouter", "brave"];
    for (const id of ids) expect(await screen.findByTestId(`api-key-row-${id}`)).toBeTruthy();
    expect(screen.getAllByText("Not set").length).toBeGreaterThanOrEqual(5);
    // No field is on the page until a row is opened.
    expect(screen.queryByLabelText("Anthropic API key")).toBeNull();
    const names = ["Anthropic", "OpenAI", "Google Gemini", "OpenRouter", "Brave Search"];
    for (const [i, id] of ids.entries()) {
      const row = await openKey(id);
      const field = within(row).getByLabelText(`${names[i]} API key`) as HTMLInputElement;
      expect(field.type).toBe("password");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByTestId(`api-key-${id}`)).toBeNull());
    }
  });

  it("puts the long explainer behind a help button", async () => {
    setup();
    await screen.findByTestId("api-key-row-anthropic");
    expect(screen.queryByText(/stored encrypted in the vault/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "About API keys" }));
    expect(await screen.findByText(/stored encrypted in the vault/)).toBeTruthy();
  });

  it("drops a pasted draft when the sheet closes", async () => {
    setup();
    const row = await openKey("openai");
    await userEvent.type(within(row).getByLabelText("OpenAI API key"), SECRET);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("api-key-openai")).toBeNull());
    expect(document.body.innerHTML).not.toContain(SECRET);
    const again = await openKey("openai");
    expect((within(again).getByLabelText("OpenAI API key") as HTMLInputElement).value).toBe("");
  });

  it("saves a key, shows only that it is saved, never renders it, then clears it", async () => {
    const gateway = setup();
    const row = await openKey("anthropic");
    const field = within(row).getByLabelText("Anthropic API key") as HTMLInputElement;
    const save = within(row).getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(field, SECRET);
    await userEvent.click(save);
    await waitFor(() => expect(within(row).getByText("Saved in the vault")).toBeTruthy());
    expect(callsOf(gateway(), "keys.set").map((c) => c.params)).toEqual([
      { id: "anthropic", key: SECRET },
    ]);
    // The draft is gone from the field and from the page.
    expect((screen.getByLabelText("Anthropic API key") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);

    await userEvent.click(within(row).getByRole("button", { name: "Clear" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(within(row).getByText("Not set")).toBeTruthy());
    expect(callsOf(gateway(), "keys.clear").map((c) => c.params)).toEqual([{ id: "anthropic" }]);
  });

  it("asks before removing a key, and keeps it when the owner cancels", async () => {
    const gateway = setup();
    await userEvent.type(within(await openKey("openai")).getByLabelText("OpenAI API key"), SECRET);
    await userEvent.click(
      within(screen.getByTestId("api-key-openai")).getByRole("button", { name: "Save" }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId("api-key-openai")).getByText("Saved in the vault"),
      ).toBeTruthy(),
    );
    await userEvent.click(
      within(screen.getByTestId("api-key-openai")).getByRole("button", { name: "Clear" }),
    );
    expect(await screen.findByText("Remove the OpenAI key?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(callsOf(gateway(), "keys.clear")).toEqual([]);
    expect(
      within(screen.getByTestId("api-key-openai")).getByText("Saved in the vault"),
    ).toBeTruthy();
  });

  it("says when the key belongs to the default model's provider", async () => {
    setup();
    const row = await openKey("anthropic");
    await userEvent.type(within(row).getByLabelText("Anthropic API key"), SECRET);
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(row).getByText("Saved in the vault")).toBeTruthy());
    await userEvent.click(within(row).getByRole("button", { name: "Clear" }));
    expect(await screen.findByText(/Your default model uses Anthropic/)).toBeTruthy();
  });

  it("refuses a key with spaces before anything is sent", async () => {
    const gateway = setup();
    const row = await openKey("brave");
    const field = within(row).getByLabelText("Brave Search API key");
    await userEvent.type(field, "has a space");
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    expect(within(row).getByRole("alert").textContent).toBe("A key has no spaces or line breaks.");
    expect(callsOf(gateway(), "keys.set")).toEqual([]);
  });

  it("keeps the pasted draft and says how to unlock when the vault is locked", async () => {
    const gateway = setup();
    const row = await openKey("openai");
    const field = within(row).getByLabelText("OpenAI API key") as HTMLInputElement;
    gateway().failNext("keys.set", "unavailable", "the vault is locked");
    await userEvent.type(field, "sk-locked-try");
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    expect((await within(row).findByRole("alert")).textContent).toMatch(/vault is locked/);
    expect((screen.getByLabelText("OpenAI API key") as HTMLInputElement).value).toBe(
      "sk-locked-try",
    );
    // After unlocking, the same draft saves and is then dropped.
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(row).getByText("Saved in the vault")).toBeTruthy());
    expect((screen.getByLabelText("OpenAI API key") as HTMLInputElement).value).toBe("");
  });

  it("tells password managers to leave the key fields alone", async () => {
    setup();
    const field = within(await openKey("anthropic")).getByLabelText("Anthropic API key");
    expect(field.getAttribute("autocomplete")).toBe("new-password");
    expect(field.hasAttribute("data-1p-ignore")).toBe(true);
    expect(field.getAttribute("data-lpignore")).toBe("true");
    expect(field.hasAttribute("data-bwignore")).toBe(true);
  });
});
