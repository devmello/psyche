import type { Channel } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import {
  ADDABLE_CHANNELS,
  AddChannelDialog,
  connectChannel,
} from "../src/screens/settings/AddChannelDialog.tsx";
import { ChannelsSection } from "../src/screens/settings/ChannelsSection.tsx";
import {
  type PendingSettingApproval,
  SettingsApprovalContext,
} from "../src/screens/settings/shared.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

function setup(opts: { withApproval?: boolean; existing?: boolean } = {}) {
  let gw: MockGateway | null = null;
  const onClose = vi.fn();
  const onAdded = vi.fn();
  const pending: PendingSettingApproval[] = [];
  const dialog = <AddChannelDialog open persona="Psyche" onClose={onClose} onAdded={onAdded} />;
  render(
    <StoryWorld
      onGateway={(g) => {
        gw = g;
        if (opts.existing) {
          const base = g.world.channels[0] as Channel;
          g.world.channels = [
            ...g.world.channels,
            { ...base, id: "chn_live", type: "slack", account: "Acme" },
          ];
        }
      }}
    >
      {opts.withApproval ? (
        <SettingsApprovalContext.Provider value={(p) => pending.push(p)}>
          {dialog}
        </SettingsApprovalContext.Provider>
      ) : (
        dialog
      )}
    </StoryWorld>,
  );
  const calls = () =>
    (gw as unknown as MockGateway).calls
      .filter((c) => c.method.startsWith("channels."))
      .map((c) => [c.method, (c.params as { name?: string }).name] as const);
  return { gateway: () => gw as unknown as MockGateway, onClose, onAdded, pending, calls };
}

async function fillSlack(form: HTMLElement) {
  await userEvent.type(within(form).getByLabelText("Workspace name"), "Acme");
  await userEvent.type(within(form).getByLabelText("Bot token"), "xoxb-secret-1");
  await userEvent.type(within(form).getByLabelText("App token"), "xapp-secret-2");
}

describe("Add a channel", () => {
  it("checks for an existing channel, stores each token, then creates the channel on the pairing policy", async () => {
    const { gateway, onAdded, onClose, calls } = setup();
    const form = await screen.findByRole("dialog");
    await userEvent.type(within(form).getByLabelText("Workspace name"), "Acme");
    await userEvent.type(within(form).getByLabelText("Bot token"), "xoxb-secret-1");
    // Connecting stays off until every field is filled.
    const connect = within(form).getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    await userEvent.type(within(form).getByLabelText("App token"), "xapp-secret-2");
    await userEvent.click(connect);
    await waitFor(() =>
      expect(onAdded).toHaveBeenCalledWith({ inactive: false, env: "PSYCHE_SLACK_WORKSPACE" }),
    );
    expect(onClose).toHaveBeenCalled();
    expect(calls()).toEqual([
      ["channels.list", undefined],
      ["channels.secrets.status", undefined],
      ["channels.secrets.set", "bot_token"],
      ["channels.secrets.set", "app_token"],
      ["channels.configure", undefined],
      ["channels.get", undefined],
    ]);
    const configure = gateway().calls.find((c) => c.method === "channels.configure");
    expect(configure?.params).toEqual({ type: "slack", account: "Acme", dmPolicy: "pairing" });
    // A token is only ever in its own secrets.set body.
    expect(JSON.stringify(configure)).not.toMatch(/xoxb|xapp/);
    // The new channel isolates each sender like the Gateway's own default.
    expect(gateway().world.channels.find((c) => c.account === "Acme")?.dmScope).toBe(
      "per-channel-peer",
    );
  });

  it("never replaces the tokens of a channel that already exists", async () => {
    const { onAdded, calls } = setup({ existing: true });
    const form = await screen.findByRole("dialog");
    await fillSlack(form);
    await userEvent.click(within(form).getByRole("button", { name: "Connect" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toMatch(/already exists, so nothing was changed/);
    expect(alert.textContent).not.toMatch(/xoxb|xapp/);
    expect(calls()).toEqual([["channels.list", undefined]]);
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("clears the tokens it stored when the Gateway refuses to create the channel", async () => {
    const { gateway, onAdded, calls } = setup();
    gateway().failNext("channels.configure", "conflict", "channel already exists");
    const form = await screen.findByRole("dialog");
    await fillSlack(form);
    await userEvent.click(within(form).getByRole("button", { name: "Connect" }));
    expect((await within(form).findByRole("alert")).textContent).toMatch(
      /couldn't add the channel/,
    );
    expect(calls().filter(([m]) => m === "channels.secrets.clear")).toEqual([
      ["channels.secrets.clear", "bot_token"],
      ["channels.secrets.clear", "app_token"],
    ]);
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("hands an approval_required to the Settings banner, stores nothing while it waits, and finishes once approved", async () => {
    const { gateway, onAdded, onClose, pending, calls } = setup({ withApproval: true });
    gateway().failNext(
      "channels.configure",
      "approval_required",
      "This needs your approval first.",
      {
        approvalId: "apr_1",
      },
    );
    const form = await screen.findByRole("dialog");
    await fillSlack(form);
    await userEvent.click(within(form).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]).toMatchObject({ approvalId: "apr_1", label: "Adding a channel" });
    expect(onClose).toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
    // The tokens stored for the first try were cleared again: nothing waits in the vault.
    expect(calls().filter(([m]) => m === "channels.secrets.clear")).toHaveLength(2);

    await pending[0]?.retry("apr_1");
    expect(onAdded).toHaveBeenCalledWith({ inactive: false, env: "PSYCHE_SLACK_WORKSPACE" });
    const configures = gateway().calls.filter((c) => c.method === "channels.configure");
    expect(configures).toHaveLength(2);
    expect(configures[1]?.params).toEqual({
      type: "slack",
      account: "Acme",
      dmPolicy: "pairing",
      approvalId: "apr_1",
    });
  });

  it("asks for the E.164 number for WhatsApp and SMS before calling the Gateway", async () => {
    const { calls } = setup();
    const form = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(form).getByLabelText("Channel"), "whatsapp");
    for (const label of [
      "WhatsApp number (+15551234567)",
      "Access token",
      "App secret",
      "Verify token",
    ]) {
      expect(within(form).getByLabelText(label)).toBeTruthy();
    }
    expect(within(form).queryByText("Phone number ID")).toBeNull();
    await userEvent.type(within(form).getByLabelText("WhatsApp number (+15551234567)"), "123456");
    await userEvent.type(within(form).getByLabelText("Access token"), "a");
    await userEvent.type(within(form).getByLabelText("App secret"), "b");
    await userEvent.type(within(form).getByLabelText("Verify token"), "c");
    await userEvent.click(within(form).getByRole("button", { name: "Connect" }));
    expect((await within(form).findByRole("alert")).textContent).toMatch(/international format/);
    expect(calls()).toEqual([]);
    expect(ADDABLE_CHANNELS.discord).toEqual(["bot_token"]);
    expect(ADDABLE_CHANNELS.sms).toEqual(["auth_token"]);
  });

  it("names the environment variable the Gateway needs for the chosen type", async () => {
    setup();
    const form = await screen.findByRole("dialog");
    expect(within(form).getByText(/PSYCHE_SLACK_WORKSPACE/)).toBeTruthy();
    await userEvent.selectOptions(within(form).getByLabelText("Channel"), "whatsapp");
    expect(within(form).getByText(/PSYCHE_WHATSAPP_NUMBER/)).toBeTruthy();
  });

  it("masks token fields and keeps password managers out", async () => {
    setup();
    const form = await screen.findByRole("dialog");
    const token = within(form).getByLabelText("Bot token") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.autocomplete).toBe("new-password");
  });
});

describe("connectChannel", () => {
  const channel = (status: Channel["status"]) => ({ id: "chn_1", status }) as Channel;
  const fake = (status: Channel["status"], fail?: string) => {
    const log: string[] = [];
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      log.push(method === "channels.secrets.set" ? `set:${params.name}` : method);
      if (method === "channels.list") return { channels: [] };
      if (method === "channels.secrets.set" || method === "channels.secrets.clear")
        return { set: [] };
      if (method === "channels.secrets.set" && params.name === fail)
        throw new Error("vault locked");
      if (method === "channels.configure") return { channel: channel(status) };
      return { channel: channel(status) };
    });
    return { call: call as never, log };
  };

  it("says the transport is not running when the created channel is not active", async () => {
    const { call } = fake("disconnected");
    const out = await connectChannel(call, {
      type: "discord",
      account: "app-1",
      secrets: { bot_token: "t" },
    });
    expect(out).toEqual({ inactive: true, env: "PSYCHE_DISCORD_ACCOUNT" });
  });

  it("clears what it stored when a later token cannot be stored", async () => {
    const log: string[] = [];
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      log.push(method === "channels.list" ? method : `${method}:${String(params.name ?? "")}`);
      if (method === "channels.list") return { channels: [] };
      if (method === "channels.secrets.set" && params.name === "app_token")
        throw new Error("vault locked");
      return { set: [] };
    });
    await expect(
      connectChannel(call as never, {
        type: "slack",
        account: "Acme",
        secrets: { bot_token: "a", app_token: "b" },
      }),
    ).rejects.toThrow("vault locked");
    expect(log).toEqual([
      "channels.list",
      "channels.secrets.status:",
      "channels.secrets.set:bot_token",
      "channels.secrets.set:app_token",
      "channels.list",
      "channels.secrets.clear:bot_token",
    ]);
  });

  it("rolls back only the tokens it stored: ones already in the vault survive a failed attempt", async () => {
    const cleared: string[] = [];
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "channels.list") return { channels: [] };
      if (method === "channels.secrets.status") return { required: [], set: ["bot_token"] };
      if (method === "channels.secrets.clear") cleared.push(String(params.name));
      if (method === "channels.configure") throw new Error("no");
      return { set: [] };
    });
    await expect(
      connectChannel(call as never, {
        type: "slack",
        account: "Acme",
        secrets: { app_token: "b" },
      }),
    ).rejects.toThrow("no");
    expect(cleared).toEqual(["app_token"]);
  });

  it("does not clear the tokens when another add created the same channel in the meantime", async () => {
    let listed = 0;
    const cleared: string[] = [];
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "channels.list") {
        listed += 1;
        // Empty at the first check, then the winner's channel exists.
        return {
          channels: listed === 1 ? [] : [{ id: "chn_w", type: "discord", account: "app-1" }],
        };
      }
      if (method === "channels.secrets.status") return { required: [], set: [] };
      if (method === "channels.secrets.clear") cleared.push(String(params.name));
      if (method === "channels.configure") throw new Error("channel already exists");
      return { set: [] };
    });
    await expect(
      connectChannel(call as never, {
        type: "discord",
        account: "app-1",
        secrets: { bot_token: "t" },
      }),
    ).rejects.toThrow("already exists");
    expect(cleared).toEqual([]);
  });

  it("does not overwrite stored tokens unless Replace is ticked", async () => {
    const { gateway, pending, calls } = setup({ withApproval: true });
    gateway().channelSecrets.set("slack|Acme", ["bot_token"]);
    gateway().failNext("channels.configure", "approval_required", "needs approval", {
      approvalId: "apr_2",
    });
    const form = await screen.findByRole("dialog");
    await userEvent.type(within(form).getByLabelText("Workspace name"), "Acme");
    const replace = (await within(form).findByLabelText(
      "Replace stored tokens",
    )) as HTMLInputElement;
    expect(replace.checked).toBe(false);
    expect(within(form).getByText(/Already stored for this account: Bot token/)).toBeTruthy();
    // The stored token's field is off; only the missing one is asked for.
    expect((within(form).getByLabelText("Bot token") as HTMLInputElement).disabled).toBe(true);
    await userEvent.type(within(form).getByLabelText("App token"), "xapp-2");
    await userEvent.click(within(form).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(pending).toHaveLength(1));
    const sets = calls().filter(([m]) => m === "channels.secrets.set");
    expect(sets).toEqual([["channels.secrets.set", "app_token"]]);
    // Only the token this attempt added is gone; the stored one is still there.
    expect(gateway().channelSecrets.get("slack|Acme")).toEqual(["bot_token"]);
  });

  it("replaces stored tokens when Replace is ticked", async () => {
    const { gateway, onAdded, calls } = setup();
    gateway().channelSecrets.set("slack|Acme", ["bot_token"]);
    const form = await screen.findByRole("dialog");
    await userEvent.type(within(form).getByLabelText("Workspace name"), "Acme");
    await userEvent.click(await within(form).findByLabelText("Replace stored tokens"));
    await userEvent.type(within(form).getByLabelText("Bot token"), "xoxb-new");
    await userEvent.type(within(form).getByLabelText("App token"), "xapp-new");
    await userEvent.click(within(form).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(calls().filter(([m]) => m === "channels.secrets.set")).toEqual([
      ["channels.secrets.set", "bot_token"],
      ["channels.secrets.set", "app_token"],
    ]);
  });

  it("refuses to drop a token the owner typed for a name that is already stored", async () => {
    // A leaked token is stored for the account; the owner types the rotated one without Replace.
    const vault = new Map<string, string>([["bot_token", "LEAKED-OLD"]]);
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "channels.list") return { channels: [] };
      if (method === "channels.secrets.status") return { required: [], set: [...vault.keys()] };
      if (method === "channels.secrets.set") vault.set(String(params.name), String(params.value));
      return { set: [], channel: { id: "chn_1", status: "active" } };
    });
    await expect(
      connectChannel(call as never, {
        type: "discord",
        account: "app-1",
        secrets: { bot_token: "ROTATED-NEW" },
      }),
    ).rejects.toThrow(/already stored for this account/);
    expect(vault.get("bot_token")).toBe("LEAKED-OLD");
    expect(call.mock.calls.map((c) => c[0])).toEqual(["channels.list", "channels.secrets.status"]);
    // Ticking Replace is the way to rotate it.
    await connectChannel(call as never, {
      type: "discord",
      account: "app-1",
      secrets: { bot_token: "ROTATED-NEW" },
      replaceStored: true,
    });
    expect(vault.get("bot_token")).toBe("ROTATED-NEW");
  });

  it("clears what was typed into a field that turns off because its token is stored", async () => {
    const { gateway, calls } = setup();
    const form = await screen.findByRole("dialog");
    await userEvent.type(within(form).getByLabelText("Workspace name"), "Acme");
    await userEvent.type(within(form).getByLabelText("Bot token"), "ROTATED-NEW");
    gateway().channelSecrets.set("slack|Acme", ["bot_token"]);
    // Re-trigger the status read by editing the account.
    await userEvent.type(within(form).getByLabelText("Workspace name"), "2");
    await userEvent.type(within(form).getByLabelText("Workspace name"), "{Backspace}");
    await within(form).findByLabelText("Replace stored tokens");
    expect((within(form).getByLabelText("Bot token") as HTMLInputElement).value).toBe("");
    await userEvent.type(within(form).getByLabelText("App token"), "xapp-2");
    await userEvent.click(within(form).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(calls().some(([m]) => m === "channels.configure")).toBe(true));
    expect(calls().filter(([m]) => m === "channels.secrets.set")).toEqual([
      ["channels.secrets.set", "app_token"],
    ]);
  });

  it("stops before storing anything when the stored tokens cannot be read", async () => {
    const log: string[] = [];
    const call = vi.fn(async (method: string) => {
      log.push(method);
      if (method === "channels.list") return { channels: [] };
      if (method === "channels.secrets.status") throw new Error("vault is locked");
      return { set: [] };
    });
    await expect(
      connectChannel(call as never, {
        type: "discord",
        account: "app-1",
        secrets: { bot_token: "t" },
      }),
    ).rejects.toThrow(/couldn't check which tokens are already stored \(.*vault is locked/);
    expect(log).toEqual(["channels.list", "channels.secrets.status"]);
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
