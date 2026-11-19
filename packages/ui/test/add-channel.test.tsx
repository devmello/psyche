import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { ADDABLE_CHANNELS, AddChannelDialog } from "../src/screens/settings/AddChannelDialog.tsx";
import { ChannelsSection } from "../src/screens/settings/ChannelsSection.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

function setup(onAdded = vi.fn()) {
  let gw: MockGateway | null = null;
  const onClose = vi.fn();
  render(
    <StoryWorld onGateway={(g) => (gw = g)}>
      <AddChannelDialog open persona="Psyche" onClose={onClose} onAdded={onAdded} />
    </StoryWorld>,
  );
  return { gateway: () => gw as unknown as MockGateway, onClose, onAdded };
}

describe("Add a channel", () => {
  it("stores each token in the vault first, then creates the channel with the pairing policy", async () => {
    const { gateway, onAdded, onClose } = setup();
    const form = await screen.findByRole("dialog");
    await userEvent.type(within(form).getByLabelText("Workspace name"), "Acme");
    await userEvent.type(within(form).getByLabelText("Bot token"), "xoxb-secret-1");
    // Fields only appear for what Slack needs; connecting stays off until all are filled.
    const connect = within(form).getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    await userEvent.type(within(form).getByLabelText("App token"), "xapp-secret-2");
    await userEvent.click(connect);
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    const calls = gateway().calls.filter((c) => c.method.startsWith("channels."));
    expect(calls.map((c) => [c.method, (c.params as { name?: string }).name])).toEqual([
      ["channels.secrets.set", "bot_token"],
      ["channels.secrets.set", "app_token"],
      ["channels.configure", undefined],
    ]);
    // The new channel starts on the safe policy: nobody gets in until the owner approves.
    expect(calls[2]?.params).toEqual({ type: "slack", account: "Acme", dmPolicy: "pairing" });
    // A token is never part of the channel call or of anything but its own secrets.set body.
    expect(JSON.stringify(calls[2])).not.toMatch(/xoxb|xapp/);
  });

  it("asks for what each type needs and nothing else", async () => {
    setup();
    const form = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(form).getByLabelText("Channel"), "whatsapp");
    for (const label of ["Phone number ID", "Access token", "App secret", "Verify token"]) {
      expect(within(form).getByLabelText(label)).toBeTruthy();
    }
    expect(within(form).queryByLabelText("Bot token")).toBeNull();
    expect(ADDABLE_CHANNELS.discord).toEqual(["bot_token"]);
    expect(ADDABLE_CHANNELS.sms).toEqual(["auth_token"]);
  });

  it("masks token fields and keeps password managers out", async () => {
    setup();
    const form = await screen.findByRole("dialog");
    const token = within(form).getByLabelText("Bot token") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.autocomplete).toBe("new-password");
  });

  it("shows the Gateway's refusal, keeps the dialog open and does not create the channel", async () => {
    const { gateway, onAdded } = setup();
    const form = await screen.findByRole("dialog");
    gateway().failNext("channels.configure", "forbidden", "presence is required");
    await userEvent.selectOptions(within(form).getByLabelText("Channel"), "discord");
    await userEvent.type(within(form).getByLabelText("Application ID"), "app-1");
    await userEvent.type(within(form).getByLabelText("Bot token"), "tok");
    await userEvent.click(within(form).getByRole("button", { name: "Connect" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't add the channel/);
    expect(alert.textContent).not.toMatch(/tok\b/);
    expect(onAdded).not.toHaveBeenCalled();
  });
});

describe("Channels section", () => {
  it("offers Add a channel when there are none", async () => {
    render(
      <StoryWorld edit={(w) => (w.channels = [])}>
        <ChannelsSection />
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Add a channel" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
