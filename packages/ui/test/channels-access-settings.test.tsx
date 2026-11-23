import type { Channel, ChannelIdentity } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld } from "../src/fixtures/index.ts";
import { ChannelsPanel, ChannelsSection } from "../src/screens/settings/ChannelsSection.tsx";
import {
  type PendingSettingApproval,
  SettingsApprovalContext,
} from "../src/screens/settings/shared.tsx";
import { StoryWorld, type StoryWorldProps } from "../src/stories/harness.tsx";

/** Settings → Channels: editing the allowlists and identity links (channels.allowlist.update,
 * channels.identities.*). Adding a sender or linking an identity is presence-gated, so the Gateway
 * answers `approval_required` and the Settings banner takes over. Removing needs no approval,
 * except the last group sender: the group list empty means everyone allowed in direct messages
 * may trigger Psyche in groups, so the Gateway asks for the card. */

const channel = (): Channel => createFixtureWorld().channels[0] as Channel;

const identity = (over: Partial<ChannelIdentity> = {}): ChannelIdentity => ({
  id: "idn_wren",
  display: "Wren",
  links: ["tg:9001"],
  delegatedPersona: null,
  toolAllow: null,
  createdAt: "2026-10-16T19:00:00Z",
  updatedAt: "2026-10-16T19:00:00Z",
  ...over,
});

/** The add form that owns a given input (the two lists each have their own). */
const formOf = (label: string): HTMLElement =>
  screen.getByLabelText(label).closest("form") as HTMLElement;

function renderPanel(over: Partial<Parameters<typeof ChannelsPanel>[0]> = {}) {
  return render(
    <ChannelsPanel
      channels={[channel()]}
      pairing={[]}
      identities={[]}
      persona="Psyche"
      {...over}
    />,
  );
}

describe("ChannelsPanel allowlist controls", () => {
  it("removes one sender without any other input", async () => {
    const onAllowlistChange = vi.fn();
    renderPanel({ onAllowlistChange });
    await userEvent.click(screen.getByRole("button", { name: "Remove partner" }));
    expect(onAllowlistChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: channel().id }),
      "allowFrom",
      { remove: ["tg:20991834"] },
    );
  });

  it("removes a group sender at once while others remain", async () => {
    const onAllowlistChange = vi.fn();
    renderPanel({
      onAllowlistChange,
      channels: [{ ...channel(), groupAllowFrom: ["tg:30000003", "tg:30000004"] }],
    });
    await userEvent.click(screen.getByRole("button", { name: "Remove Kim" }));
    expect(onAllowlistChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: channel().id }),
      "groupAllowFrom",
      { remove: ["tg:30000003"] },
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks first when removing the last group sender would open groups to everyone allowed in direct messages", async () => {
    const onAllowlistChange = vi.fn();
    renderPanel({ onAllowlistChange });
    await userEvent.click(screen.getByRole("button", { name: "Remove Kim" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/everyone allowed in direct messages can trigger Psyche in groups/),
    ).toBeTruthy();
    expect(onAllowlistChange).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onAllowlistChange).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Remove Kim" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );
    expect(onAllowlistChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: channel().id }),
      "groupAllowFrom",
      { remove: ["tg:30000003"] },
    );
  });

  it("adds a sender and a group sender from their inputs, and never sends an empty or listed id", async () => {
    const onAllowlistChange = vi.fn();
    renderPanel({ onAllowlistChange });
    const senderForm = formOf("Sender to allow");
    const addSender = within(senderForm).getByRole("button", { name: "Add sender" });
    expect((addSender as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(screen.getByLabelText("Sender to allow"), "  tg:55555  ");
    await userEvent.click(addSender);
    expect(onAllowlistChange).toHaveBeenLastCalledWith(expect.anything(), "allowFrom", {
      add: ["tg:55555"],
    });

    // Already on the list: nothing is sent.
    const calls = onAllowlistChange.mock.calls.length;
    await userEvent.type(screen.getByLabelText("Sender to allow"), "tg:10442211");
    await userEvent.click(within(senderForm).getByRole("button", { name: "Add sender" }));
    expect(onAllowlistChange).toHaveBeenCalledTimes(calls);

    const groupForm = formOf("Add a sender (group chats)");
    await userEvent.type(screen.getByLabelText("Add a sender (group chats)"), "tg:30000009");
    await userEvent.click(within(groupForm).getByRole("button", { name: "Add sender" }));
    expect(onAllowlistChange).toHaveBeenLastCalledWith(expect.anything(), "groupAllowFrom", {
      add: ["tg:30000009"],
    });
  });

  it("omits the allowlist controls when no handler is given", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "Remove partner" })).toBeNull();
    expect(screen.queryByLabelText("Sender to allow")).toBeNull();
  });
});

describe("ChannelsPanel identity controls", () => {
  it("links a name to comma-separated sender ids, and unlinks an identity", async () => {
    const onIdentityLink = vi.fn();
    const onIdentityUnlink = vi.fn();
    renderPanel({ identities: [identity()], onIdentityLink, onIdentityUnlink });

    await userEvent.click(screen.getByRole("button", { name: "Unlink Wren" }));
    expect(onIdentityUnlink).toHaveBeenCalledWith(expect.objectContaining({ id: "idn_wren" }));

    const link = screen.getByRole("button", { name: "Link identity" });
    expect((link as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Person's name"), "Marta");
    expect((link as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(
      screen.getByLabelText("Sender IDs, separated by commas"),
      " tg:1 , ,tg:2 ",
    );
    expect((link as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(link);
    expect(onIdentityLink).toHaveBeenCalledWith({ display: "Marta", links: ["tg:1", "tg:2"] });
  });
});

type SectionWorld = Omit<StoryWorldProps, "children">;

function setupSection(world: SectionWorld = {}, seed?: (g: MockGateway) => void) {
  let gw: MockGateway | null = null;
  const pending: PendingSettingApproval[] = [];
  render(
    <StoryWorld
      {...world}
      onGateway={(g) => {
        gw = g;
        seed?.(g);
      }}
    >
      <SettingsApprovalContext.Provider value={(p) => pending.push(p)}>
        <ChannelsSection />
      </SettingsApprovalContext.Provider>
    </StoryWorld>,
  );
  return {
    gateway: () => {
      if (gw === null) throw new Error("gateway not ready");
      return gw;
    },
    pending,
  };
}

const callsOf = (g: MockGateway, method: string) => g.calls.filter((c) => c.method === method);

describe("Channels allowlist and identities over the Gateway", () => {
  it("removes a sender at once, because removing needs no approval", async () => {
    const { gateway, pending } = setupSection();
    await userEvent.click(await screen.findByRole("button", { name: "Remove partner" }));
    await waitFor(() => expect(callsOf(gateway(), "channels.allowlist.update")).toHaveLength(1));
    expect(callsOf(gateway(), "channels.allowlist.update")[0]?.params).toEqual({
      channelId: gateway().world.channels[0]?.id,
      list: "allowFrom",
      remove: ["tg:20991834"],
    });
    expect(pending).toHaveLength(0);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove partner" })).toBeNull(),
    );
  });

  it("asks for approval before adding a sender, and adds it once the owner approves", async () => {
    const { gateway, pending } = setupSection();
    gateway().failNext("channels.allowlist.update", "approval_required", "needs approval", {
      approvalId: "apr_add_sender",
    });
    await userEvent.type(await screen.findByLabelText("Sender to allow"), "tg:55555");
    await userEvent.click(
      within(formOf("Sender to allow")).getByRole("button", { name: "Add sender" }),
    );

    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]).toMatchObject({
      approvalId: "apr_add_sender",
      label: "Allowing a chat sender",
    });
    const channelId = gateway().world.channels[0]?.id;
    const first = callsOf(gateway(), "channels.allowlist.update")[0];
    expect(first?.params).toEqual({ channelId, list: "allowFrom", add: ["tg:55555"] });
    // The banner runs the same call again with the approval; the Gateway checks its binding.
    await pending[0]?.retry("apr_add_sender");
    expect(callsOf(gateway(), "channels.allowlist.update").at(-1)?.params).toEqual({
      channelId,
      list: "allowFrom",
      add: ["tg:55555"],
      approvalId: "apr_add_sender",
    });
    expect(gateway().world.channels[0]?.allowFrom).toContain("tg:55555");
  });

  it("asks for approval when removing the last group sender, and removes it once approved", async () => {
    const { gateway, pending } = setupSection();
    gateway().failNext("channels.allowlist.update", "approval_required", "needs approval", {
      approvalId: "apr_last_group",
    });
    await userEvent.click(await screen.findByRole("button", { name: "Remove Kim" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]).toMatchObject({
      approvalId: "apr_last_group",
      label: "Changing who can trigger me in groups",
    });
    await pending[0]?.retry("apr_last_group");
    expect(callsOf(gateway(), "channels.allowlist.update").at(-1)?.params).toEqual({
      channelId: gateway().world.channels[0]?.id,
      list: "groupAllowFrom",
      remove: ["tg:30000003"],
      approvalId: "apr_last_group",
    });
    expect(gateway().world.channels[0]?.groupAllowFrom).toEqual([]);
  });

  it("shows a refused change inline and changes nothing", async () => {
    const { gateway, pending } = setupSection();
    gateway().failNext("channels.allowlist.update", "forbidden", "not an admin");
    await userEvent.type(await screen.findByLabelText("Sender to allow"), "tg:77");
    await userEvent.click(
      within(formOf("Sender to allow")).getByRole("button", { name: "Add sender" }),
    );
    expect(
      await screen.findByText(
        "Changing who can message needs an admin device. Use a device paired as admin.",
      ),
    ).toBeTruthy();
    expect(pending).toHaveLength(0);
    expect(gateway().world.channels[0]?.allowFrom).not.toContain("tg:77");
  });

  it("links an identity after approval, then unlinks it without approval", async () => {
    const { gateway, pending } = setupSection({}, (g) => {
      g.world.channelIdentities = [identity()];
    });
    gateway().failNext("channels.identities.upsert", "approval_required", "needs approval", {
      approvalId: "apr_identity",
    });
    await userEvent.type(await screen.findByLabelText("Person's name"), "Marta");
    await userEvent.type(screen.getByLabelText("Sender IDs, separated by commas"), "tg:1, tg:2");
    await userEvent.click(screen.getByRole("button", { name: "Link identity" }));
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]).toMatchObject({
      approvalId: "apr_identity",
      label: "Linking a chat identity",
    });
    await pending[0]?.retry("apr_identity");
    expect(gateway().world.channelIdentities.map((i) => i.display)).toContain("Marta");

    await userEvent.click(await screen.findByRole("button", { name: "Unlink Wren" }));
    await waitFor(() =>
      expect(callsOf(gateway(), "channels.identities.delete").map((c) => c.params)).toEqual([
        { identityId: "idn_wren" },
      ]),
    );
    await waitFor(() =>
      expect(gateway().world.channelIdentities.map((i) => i.id)).not.toContain("idn_wren"),
    );
  });
});
