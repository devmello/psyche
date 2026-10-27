import type { ApprovalRequest } from "@psyche/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  type GatewayClient,
  GatewayProvider,
  GatewayRequestError,
  GatewayStore,
} from "../src/data/index.ts";
import type { RecordedCall } from "../src/data/mock-gateway.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS, PERSONA } from "../src/fixtures/index.ts";
import { actionLabel } from "../src/screens/settings/ActionMatrix.tsx";
import { AppearancePanel } from "../src/screens/settings/AppearanceSection.tsx";
import { ChannelsPanel } from "../src/screens/settings/ChannelsSection.tsx";
import { ConnectorsSection } from "../src/screens/settings/ConnectorsSection.tsx";
import {
  cardRefusal,
  parseBinding,
  vaultChangeError,
} from "../src/screens/settings/CredentialsSection.tsx";
import { folderGrants, policyWithFolders } from "../src/screens/settings/FileAccessSection.tsx";
import { ModelProvidersPanel } from "../src/screens/settings/ModelSection.tsx";
import { presenceUnavailable } from "../src/screens/settings/SettingsApproval.tsx";
import {
  SettingsScreen,
  type SettingsScreenProps,
} from "../src/screens/settings/SettingsScreen.tsx";
import { sampleProviders, sampleSettings } from "../src/screens/settings/sample-data.ts";
import { UiSlotsProvider } from "../src/slots.tsx";
import { StoryWorld, type StoryWorldProps } from "../src/stories/harness.tsx";

const NOW = Date.parse(FIXTURE_NOW);

function setup(
  props: Partial<SettingsScreenProps> = {},
  world: Omit<StoryWorldProps, "children"> = {},
): { gateway: () => MockGateway; navigate: ReturnType<typeof vi.fn> } {
  let gw: MockGateway | null = null;
  const navigate = vi.fn();
  render(
    <StoryWorld
      {...world}
      edit={(w) => {
        Object.assign(w.settings, sampleSettings());
        world.edit?.(w);
      }}
      onGateway={(g) => {
        gw = g;
        world.onGateway?.(g);
      }}
      slots={{ navigate }}
    >
      <SettingsScreen now={NOW} {...props} />
    </StoryWorld>,
  );
  return {
    gateway: () => {
      if (gw === null) throw new Error("gateway not ready");
      return gw;
    },
    navigate,
  };
}

const callsOf = (g: MockGateway, method: string): RecordedCall[] =>
  g.calls.filter((c) => c.method === method);

const settingCall = (g: MockGateway, key: string) =>
  callsOf(g, "settings.set").find((c) => (c.params as { key: string }).key === key);

/** The value of the first `settings.set` for `key`, or `undefined`. */
function settingValue(g: MockGateway, key: string): unknown {
  const call = settingCall(g, key);
  return call === undefined ? undefined : (call.params as { value: unknown }).value;
}

describe("SettingsScreen", () => {
  it("lists every section and marks the current one", async () => {
    const { navigate } = setup({ defaultSection: "appearance" });
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const items = within(nav).getAllByRole("button");
    // 15 sections of UI design §2.6 plus Browser (I13), Skills (T2), VM mode (L1–L5),
    // People & projects (#652), Specialists (#685) and Mail & meetings (#672).
    expect(items).toHaveLength(21);
    expect(items.map((b) => b.textContent?.trim())).toContain("People & projects");
    expect(items.map((b) => b.textContent?.trim())).toContain("Skills");
    expect(items.map((b) => b.textContent?.trim())).toContain("Specialists");
    expect(items.map((b) => b.textContent?.trim())).toContain("Mail & meetings");
    expect(items.map((b) => b.textContent?.trim())).toContain("VM mode");
    expect(items.map((b) => b.textContent?.trim())).toContain("Browser");
    expect(
      within(nav).getByRole("button", { name: "Appearance" }).getAttribute("aria-current"),
    ).toBe("page");
    await userEvent.click(within(nav).getByRole("button", { name: "Permissions" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Permissions" })).toBeTruthy();
    expect(
      within(nav).getByRole("button", { name: "Permissions" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(navigate).toHaveBeenCalledWith("/settings/permissions");
  });

  it("moves focus through the section nav with the arrow keys", async () => {
    setup({ defaultSection: "model" });
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    within(nav).getByRole("button", { name: "Model & providers" }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Persona");
    await userEvent.keyboard("{End}");
    expect(document.activeElement?.textContent).toBe("About");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Model & providers");
  });
});

describe("Appearance", () => {
  it("writes appearance.* keys and previews the generated scales with WCAG ratios", async () => {
    const { gateway } = setup({ defaultSection: "appearance" });
    await userEvent.click(await screen.findByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(settingValue(gateway(), "appearance.theme")).toBe("dark"));
    await userEvent.click(screen.getByRole("radio", { name: "Blue" }));
    await waitFor(() =>
      expect(settingValue(gateway(), "appearance.accentSeed")).toBe("oklch(0.6 0.19 255)"),
    );
    expect(
      within(screen.getByRole("list", { name: "Light accent scale" })).getAllByRole("listitem"),
    ).toHaveLength(12);
    expect(
      within(screen.getByRole("list", { name: "Dark gray scale" })).getAllByRole("listitem"),
    ).toHaveLength(12);
    const light = screen.getByRole("list", { name: "Light contrast (WCAG 2)" });
    expect(within(light).getByText(/Accent 11 on 2/)).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "High contrast" }));
    await waitFor(() => expect(settingCall(gateway(), "appearance.contrast")).toBeTruthy());
  });

  it("rejects an unreadable custom color without writing it", async () => {
    const { gateway } = setup({ defaultSection: "appearance" });
    const input = await screen.findByRole("textbox", { name: "Custom color" });
    await userEvent.type(input, "not a color{Enter}");
    expect(screen.getByText(/Psyche can't read that color/)).toBeTruthy();
    expect(settingCall(gateway(), "appearance.accentSeed")).toBeUndefined();
  });

  it("turns translucent controls off and on, and reduce transparency (#608)", async () => {
    const { gateway } = setup({ defaultSection: "appearance" });
    const reduce = await screen.findByRole("switch", { name: "Reduce transparency" });
    expect(screen.queryByRole("switch", { name: "Translucent sidebar" })).toBeNull();
    await userEvent.click(reduce);
    await waitFor(() =>
      expect(settingValue(gateway(), "appearance.reduceTransparency")).toBe(true),
    );

    const onChange = vi.fn();
    const panel = render(<AppearancePanel values={{}} onChange={onChange} />);
    const glass = within(panel.container).getByRole("switch", { name: "Translucent controls" });
    expect(glass.getAttribute("aria-checked")).toBe("true");
    expect(within(panel.container).queryByRole("slider")).toBeNull();
    await userEvent.click(glass);
    expect(onChange).toHaveBeenCalledWith("appearance.glass", "opaque");
    panel.unmount();

    // On again: the Regular preset, and an earlier build's Advanced value is cleared.
    const again = render(
      <AppearancePanel
        values={{ "appearance.glass": "opaque", "appearance.glassTint": 50 }}
        onChange={onChange}
      />,
    );
    await userEvent.click(
      within(again.container).getByRole("switch", { name: "Translucent controls" }),
    );
    expect(onChange).toHaveBeenCalledWith("appearance.glass", "regular");
    expect(onChange).toHaveBeenCalledWith("appearance.glassTint", null);
  });
});

describe("Admin-only settings", () => {
  it("shows a needs-approval hint when an admin key is forbidden", async () => {
    const { gateway } = setup(
      { defaultSection: "permissions" },
      { onGateway: (g) => g.failNext("settings.set", "forbidden") },
    );
    await userEvent.click(await screen.findByRole("radio", { name: /^Manual/ }));
    expect(await screen.findByText(/Needs approval on this device/)).toBeTruthy();
    expect(settingCall(gateway(), "permissions.mode")).toBeTruthy();
    // The optimistic value rolls back to the stored one.
    await waitFor(() =>
      expect(
        (screen.getByRole("radio", { name: /^Balanced/ }) as HTMLElement).getAttribute(
          "aria-checked",
        ),
      ).toBe("true"),
    );
  });

  it("reports a refused cosmetic key as an error, not a hint", async () => {
    setup(
      { defaultSection: "appearance" },
      { onGateway: (g) => g.failNext("settings.set", "forbidden") },
    );
    await userEvent.click(await screen.findByRole("radio", { name: "Dark" }));
    expect(await screen.findByText(/Psyche couldn't save “Theme”/)).toBeTruthy();
    expect(screen.queryByText(/Needs approval on this device/)).toBeNull();
  });

  it("hints under the field for any admin key, e.g. voice settings", async () => {
    setup(
      { defaultSection: "voice" },
      { onGateway: (g) => g.failNext("settings.set", "forbidden") },
    );
    await userEvent.click(await screen.findByRole("radio", { name: "Right Option" }));
    expect(await screen.findByText(/Needs approval on this device/)).toBeTruthy();
  });
});

describe("Permissions", () => {
  it("edits the per-connector matrix with MCP keys as written", async () => {
    const { gateway } = setup({ defaultSection: "permissions" });
    const list = await screen.findByRole("list", { name: "Notion actions" });
    // The raw key appears only from the row's ⋯ → "Show technical name" (redesign §5.8).
    expect(within(list).queryByText("mcp__notion__search")).toBeNull();
    await userEvent.click(within(list).getByRole("button", { name: "More for search" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Show technical name" }));
    expect(await within(list).findByText("mcp__notion__search")).toBeTruthy();
    await userEvent.click(within(list).getByRole("radio", { name: "search: Deny" }));
    await waitFor(() => {
      const matrix = settingValue(gateway(), `permissions.connectors.${IDS.connectors.notion}`) as
        | Record<string, string>
        | undefined;
      expect(matrix?.mcp__notion__search).toBe("deny");
    });
    expect(screen.getByText("tools/list hash ok")).toBeTruthy();
  });

  it("revokes a grant from the ledger", async () => {
    const { gateway } = setup({ defaultSection: "permissions" });
    const ledger = await screen.findByRole("table", { name: "Grants ledger" });
    await userEvent.click(within(ledger).getByRole("button", { name: "Revoke acme.com (rw)" }));
    await waitFor(() =>
      expect(callsOf(gateway(), "grants.revoke")[0]?.params).toEqual({
        grantId: IDS.grants.acmeSite,
      }),
    );
    await waitFor(() =>
      expect(within(ledger).getAllByText("Revoked").length).toBeGreaterThanOrEqual(2),
    );
  });

  it("lists the prep-note grant by what it covers and revokes it from the ledger", async () => {
    const { gateway } = setup(
      { defaultSection: "permissions" },
      {
        edit: (w) => {
          w.grants.push({
            id: "grant_prep_notes",
            kind: "connector_action",
            scope: "always",
            grantKey: "notes_create|connector_action:apple-notes:notes_create:title-prefix:Prep:",
            subject: { tool: "notes_create", titlePrefix: "Prep:", acceptsTaint: true },
            binding: null,
            expiresAt: "2027-01-17T10:00:00Z",
            useCount: 2,
            lastUsedAt: null,
            createdFromApprovalId: "apr_batch_1",
            taskId: null,
            createdAt: "2026-10-18T09:58:00Z",
            revokedAt: null,
          });
        },
      },
    );
    const ledger = await screen.findByRole("table", { name: "Grants ledger" });
    // Named for its one title class, not by the raw grant key.
    expect(within(ledger).queryByText(/title-prefix/)).toBeNull();
    await userEvent.click(
      within(ledger).getByRole("button", { name: 'Revoke Notes titled "Prep:" (meeting prep)' }),
    );
    await waitFor(() =>
      expect(callsOf(gateway(), "grants.revoke")[0]?.params).toEqual({
        grantId: "grant_prep_notes",
      }),
    );
  });

  it("shows Grants revoked when an MCP tools/list hash changed", async () => {
    setup(
      { defaultSection: "permissions" },
      {
        edit: (w) => {
          const notion = w.connectors.find((c) => c.id === IDS.connectors.notion);
          if (notion) notion.lastSync = { ...notion.lastSync, toolsListChanged: true };
        },
      },
    );
    expect(await screen.findByText("Grants revoked")).toBeTruthy();
    expect(screen.getByText(/changed its tool list since you approved it/)).toBeTruthy();
  });

  it("lists the hard prohibitions read-only behind Show", async () => {
    setup({ defaultSection: "permissions" });
    const show = await screen.findByRole("button", { name: "Show" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(show);
    expect(screen.getByRole("button", { name: "Hide" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Solve or bypass a CAPTCHA")).toBeTruthy();
  });
});

describe("Connectors", () => {
  it("keeps Disconnect and Remove separate and asks read-only vs read-and-act", async () => {
    const onDisconnect = vi.fn();
    const onRemove = vi.fn();
    const onConnect = vi.fn();
    setup({ defaultSection: "connectors", onDisconnect, onRemove, onConnect });
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect Gmail" }));
    expect(onDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({ id: IDS.connectors.gmail }),
    );
    expect(onRemove).not.toHaveBeenCalled();
    // Remove lives under ⋯ and asks first (audit decision 7).
    await userEvent.click(screen.getByRole("button", { name: "More for Gmail" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Gmail?" });
    expect(onRemove).not.toHaveBeenCalled();
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: IDS.connectors.gmail }));
    expect(screen.getAllByText("Trust: community")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Add connector" }));
    await userEvent.click(screen.getByRole("button", { name: /^Google/ }));
    await userEvent.click(screen.getByRole("radio", { name: /^Read and act/ }));
    await userEvent.click(screen.getByRole("button", { name: "Continue to sign in" }));
    expect(onConnect).toHaveBeenCalledWith("google", "read_act");
  });
});

describe("Computer use", () => {
  it("shows denied TCC rows, locked caps and per-app tiers", async () => {
    const onOpenSystemSettings = vi.fn();
    const { gateway } = setup({
      defaultSection: "computer-use",
      tcc: { accessibility: "granted", screenRecording: "denied" },
      onOpenSystemSettings,
    });
    expect(await screen.findByText("Denied")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Open System Settings for Screen Recording" }),
    );
    expect(onOpenSystemSettings).toHaveBeenCalledWith("screenRecording");
    expect(
      screen.queryByRole("button", { name: "Open System Settings for Accessibility" }),
    ).toBeNull();
    const apps = screen.getByRole("list", { name: "App access" });
    const row = within(apps)
      .getAllByRole("listitem")
      .find((li) => li.textContent?.includes("1Password")) as HTMLElement;
    expect(within(row).getByText("Off (fixed)")).toBeTruthy();
    expect(within(row).queryByRole("radio")).toBeNull();
    expect(screen.getAllByText("Click only (fixed)")).toHaveLength(2);
    await userEvent.click(screen.getByRole("radio", { name: "Notes: Read and interact" }));
    await waitFor(() => {
      const apps = settingValue(gateway(), "computerUse.apps") as { id: string; tier: string }[];
      expect(apps.find((a) => a.id === "com.apple.Notes")?.tier).toBe("interact");
    });
    // Apps the agent used but the owner never chose are on Ask (J5 first-use prompts).
    await userEvent.click(screen.getByRole("radio", { name: "Notes: Ask" }));
    await waitFor(() => {
      const last = callsOf(gateway(), "settings.set")
        .filter((c) => (c.params as { key: string }).key === "computerUse.apps")
        .at(-1);
      const apps =
        (last?.params as { value: { id: string; tier: string }[] } | undefined)?.value ?? [];
      expect(apps.find((a) => a.id === "com.apple.Notes")?.tier).toBe("ask");
    });
    // One segmented radio group per app (audit decision 2): the arrow keys move within it.
    const notes = screen.getByRole("radiogroup", { name: "Notes" });
    expect(within(notes).getAllByRole("radio")).toHaveLength(4);
    screen.getByRole("radio", { name: "Notes: Ask" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Notes: Off" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(screen.getByText("Esc")).toBeTruthy();
  });
});

describe("Channels", () => {
  it("warns before choosing open and approves pending senders", async () => {
    const world = createFixtureWorld();
    const onPolicyChange = vi.fn();
    const onApprove = vi.fn();
    const onIgnore = vi.fn();
    render(
      <ChannelsPanel
        channels={world.channels}
        pairing={world.pairingRequests}
        identities={[]}
        persona={PERSONA.name}
        now={NOW}
        onPolicyChange={onPolicyChange}
        onApprove={onApprove}
        onIgnore={onIgnore}
      />,
    );
    expect(screen.getByText("Pending (2 of 3)")).toBeTruthy();
    expect(screen.getByText("48-21")).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: /^Open/ }));
    expect(screen.getByRole("alert").textContent).toMatch(/Pairing is safer/);
    expect(onPolicyChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Open it anyway" }));
    expect(onPolicyChange).toHaveBeenCalledWith(expect.anything(), "open");
    await userEvent.click(screen.getByRole("button", { name: "Approve @sam_k" }));
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: IDS.pairing.samK }));
    await userEvent.click(screen.getByRole("button", { name: "Ignore @marta_lx" }));
    expect(onIgnore).toHaveBeenCalledWith(
      expect.objectContaining({ id: IDS.pairing.channelSecond }),
    );
  });
});

describe("Credentials", () => {
  it("lists metadata only and explains that card numbers are refused", async () => {
    const { gateway } = setup({ defaultSection: "credentials" });
    const table = await screen.findByRole("table", { name: "Stored credentials" });
    expect(within(table).getByText("GitHub")).toBeTruthy();
    // Slugs are level 2: in the item sheet, not the row.
    expect(within(table).queryByText("github-login")).toBeNull();
    expect(within(table).getByText("github.com")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add item" }));
    expect(screen.getByText(cardRefusal())).toBeTruthy();
    const form = screen.getByRole("form", { name: "Add a credential" });
    await userEvent.type(within(form).getByLabelText("Name"), "Fastmail");
    await userEvent.type(within(form).getByLabelText("Username"), "you");
    const secret = within(form).getByLabelText("Password") as HTMLInputElement;
    expect(secret.type).toBe("password");
    await userEvent.type(secret, "hunter2-secret");
    await userEvent.click(within(form).getByRole("button", { name: "Store in vault" }));
    await waitFor(() => expect(callsOf(gateway(), "vault.add")).toHaveLength(1));
    expect(await within(table).findByText("Fastmail")).toBeTruthy();
    // The value is never displayed, and the mock vault never kept it.
    expect(document.body.textContent).not.toContain("hunter2-secret");
    expect(JSON.stringify(gateway().world.credentials)).not.toContain("hunter2-secret");
  });

  it("reports a refused card number without echoing it", async () => {
    // Built at runtime so the repository's secret scanner finds no card-shaped literal.
    const cardLike = ["4111", ...Array<string>(3).fill("1111")].join(" ");
    setup({ defaultSection: "credentials" });
    await screen.findByRole("table", { name: "Stored credentials" });
    await userEvent.click(screen.getByRole("button", { name: "Add item" }));
    const form = screen.getByRole("form", { name: "Add a credential" });
    await userEvent.type(within(form).getByLabelText("Name"), "Visa");
    await userEvent.type(within(form).getByLabelText("Username"), "you");
    await userEvent.type(within(form).getByLabelText("Password"), cardLike);
    await userEvent.click(within(form).getByRole("button", { name: "Store in vault" }));
    expect(await screen.findByText(/looks like a card, bank or ID number/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(cardLike);
  });

  it("searches by name, site or kind", async () => {
    setup({ defaultSection: "credentials" });
    const table = await screen.findByRole("table", { name: "Stored credentials" });
    const search = screen.getByRole("searchbox", { name: "Search credentials" });
    await userEvent.type(search, "acme");
    expect(within(table).queryByText("GitHub")).toBeNull();
    expect(within(table).getByRole("button", { name: "acme.com" })).toBeTruthy();
    await userEvent.clear(search);
    await userEvent.type(search, "payment");
    expect(within(table).getByRole("button", { name: "Link wallet" })).toBeTruthy();
    expect(within(table).queryByRole("button", { name: "acme.com" })).toBeNull();
    await userEvent.clear(search);
    await userEvent.type(search, "nothing-here");
    expect(screen.getByText('No credentials match "nothing-here".')).toBeTruthy();
  });

  it("edits a login: renames it, binds a second site and replaces only the typed value", async () => {
    const { gateway } = setup({ defaultSection: "credentials" });
    const table = await screen.findByRole("table", { name: "Stored credentials" });
    await userEvent.click(within(table).getByRole("button", { name: "Edit GitHub" }));
    const form = screen.getByRole("form", { name: "Edit GitHub" });
    const save = within(form).getByRole("button", { name: "Save changes" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    const name = within(form).getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "GitHub (work)");
    const site = within(form).getByLabelText("Add a site");
    await userEvent.type(site, "not a site{Enter}");
    expect(within(form).getByRole("alert").textContent).toBe("Enter a site such as github.com.");
    await userEvent.clear(site);
    await userEvent.type(site, "https://gist.github.com/you{Enter}");
    expect(within(form).getByRole("button", { name: "Remove gist.github.com" })).toBeTruthy();
    const password = within(form).getByLabelText("New password") as HTMLInputElement;
    expect(password.type).toBe("password");
    await userEvent.type(password, "rotated-secret-9");
    await userEvent.click(save);
    await waitFor(() => expect(callsOf(gateway(), "vault.update")).toHaveLength(1));
    // A blank username is left out, so the stored one is kept.
    expect(callsOf(gateway(), "vault.update")[0]?.params).toEqual({
      credentialId: IDS.credentials.github,
      name: "GitHub (work)",
      bindings: [{ origin: "https://github.com" }, { origin: "https://gist.github.com" }],
      secret: { password: "rotated-secret-9" },
    });
    await waitFor(() => expect(screen.queryByRole("form", { name: /^Edit / })).toBeNull());
    expect(await within(table).findByText("github.com, gist.github.com")).toBeTruthy();
    expect(document.body.textContent).not.toContain("rotated-secret-9");
  });

  it("removes an item from ⋯ only after confirmation (#511)", async () => {
    const { gateway } = setup({ defaultSection: "credentials" });
    const table = await screen.findByRole("table", { name: "Stored credentials" });
    await userEvent.click(within(table).getByRole("button", { name: "More for acme.com" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove acme.com?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(callsOf(gateway(), "vault.delete")).toHaveLength(0);
    await userEvent.click(within(table).getByRole("button", { name: "More for acme.com" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const again = await screen.findByRole("alertdialog", { name: "Remove acme.com?" });
    await userEvent.click(within(again).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(callsOf(gateway(), "vault.delete")).toHaveLength(1));
    expect(callsOf(gateway(), "vault.delete")[0]?.params).toEqual({
      credentialId: IDS.credentials.acme,
    });
    await waitFor(() =>
      expect(within(table).queryByRole("button", { name: "acme.com" })).toBeNull(),
    );
  });

  it("leaves connector-owned items to their connector and links there (#511)", async () => {
    const { navigate } = setup(
      { defaultSection: "credentials" },
      {
        edit: (w) => {
          w.credentials = w.credentials.map((c) =>
            c.id === IDS.credentials.github ? { ...c, ownerConnectorId: "conn_github" } : c,
          );
        },
      },
    );
    const table = await screen.findByRole("table", { name: "Stored credentials" });
    expect(within(table).queryByRole("button", { name: "Edit GitHub" })).toBeNull();
    expect(within(table).getByText("Managed by its connector")).toBeTruthy();
    await userEvent.click(within(table).getByRole("button", { name: "More for GitHub" }));
    expect(screen.queryByRole("menuitem", { name: "Remove" })).toBeNull();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove in Connectors…" }));
    expect(navigate).toHaveBeenCalledWith("/settings/connectors");
    expect(within(table).getByRole("button", { name: "Edit acme.com" })).toBeTruthy();
  });

  it("says where Gateway-owned keys are removed and removes password-manager links (#511)", async () => {
    const { gateway, navigate } = setup(
      { defaultSection: "credentials" },
      {
        edit: (w) => {
          w.credentials = w.credentials.map((c) =>
            c.id === IDS.credentials.github
              ? {
                  ...c,
                  managedBy: { kind: "model_provider", setting: "models", removable: false },
                }
              : c.id === IDS.credentials.acme
                ? {
                    ...c,
                    backend: "1password",
                    managedBy: {
                      kind: "external_manager",
                      setting: "credentials",
                      removable: true,
                    },
                  }
                : c,
          );
        },
      },
    );
    const table = await screen.findByRole("table", { name: "Stored credentials" });
    expect(within(table).getByText("A model provider's key")).toBeTruthy();
    await userEvent.click(within(table).getByRole("button", { name: "More for GitHub" }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove in Model & providers…" }),
    );
    expect(navigate).toHaveBeenCalledWith("/settings/model");
    // Removing a 1Password link forgets the link only.
    await userEvent.click(within(table).getByRole("button", { name: "More for acme.com" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove acme.com?" });
    expect(dialog.textContent).toContain("The item stays in 1Password.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(callsOf(gateway(), "vault.delete")).toHaveLength(1));
  });

  it("imports a CSV export, reports skipped rows and never shows a value", async () => {
    const { gateway } = setup({ defaultSection: "credentials" });
    const table = await screen.findByRole("table", { name: "Stored credentials" });
    await userEvent.click(screen.getByRole("button", { name: "More ways to add" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Import a CSV export" }));
    const form = screen.getByRole("form", { name: "Import credentials" });
    const importButton = within(form).getByRole("button", { name: "Import" });
    expect((importButton as HTMLButtonElement).disabled).toBe(true);
    const csv = [
      "name,url,username,password",
      "Fastmail,https://app.fastmail.com/login,you,imported-secret-1",
      "Half a row,https://example.com,you,",
    ].join("\n");
    await userEvent.upload(
      within(form).getByLabelText("CSV file"),
      new File([csv], "chrome.csv", { type: "text/csv" }),
    );
    await userEvent.selectOptions(within(form).getByLabelText("Exported from"), "chrome");
    await userEvent.click(importButton);
    const status = await within(form).findByRole("status");
    expect(status.textContent).toContain("Imported 1 item; skipped 1 row.");
    expect(status.textContent).toContain("Row 3: no name or password");
    expect(callsOf(gateway(), "vault.import")[0]?.params).toEqual({ format: "chrome", csv });
    expect(await within(table).findByText("Fastmail")).toBeTruthy();
    expect(within(table).getByText("app.fastmail.com")).toBeTruthy();
    expect(document.body.textContent).not.toContain("imported-secret-1");
    await userEvent.click(within(form).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("form", { name: "Import credentials" })).toBeNull();
  });

  it("explains a CSV the vault can't read", async () => {
    setup({ defaultSection: "credentials" });
    await screen.findByRole("table", { name: "Stored credentials" });
    await userEvent.click(screen.getByRole("button", { name: "More ways to add" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Import a CSV export" }));
    const form = screen.getByRole("form", { name: "Import credentials" });
    await userEvent.upload(
      within(form).getByLabelText("CSV file"),
      new File(["colour,size\nred,9"], "notes.csv", { type: "text/csv" }),
    );
    await userEvent.click(within(form).getByRole("button", { name: "Import" }));
    expect(
      await within(form).findByText(/couldn't read that file as a 1Password, Bitwarden or Chrome/),
    ).toBeTruthy();
  });

  it("opens an item's detail with its last 50 uses and links each task", async () => {
    const { gateway, navigate } = setup({ defaultSection: "credentials" });
    const table = await screen.findByRole("table", { name: "Stored credentials" });
    await userEvent.click(within(table).getByRole("button", { name: "GitHub" }));
    const sheet = await screen.findByRole("dialog", { name: "GitHub" });
    const uses = await within(sheet).findByRole("table", { name: "Recent uses" });
    expect(callsOf(gateway(), "vault.uses")[0]?.params).toEqual({
      credentialId: IDS.credentials.github,
      limit: 50,
    });
    // A header row and the three fixture uses, newest first.
    const rows = within(uses).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(within(rows[1] as HTMLElement).getByText("Filled")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Denied")).toBeTruthy();
    const copy = within(rows[2] as HTMLElement).getByRole("button", {
      name: "Approved. Copy approval id ap_github_fill_2",
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await userEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith("ap_github_fill_2");
    expect(await within(rows[2] as HTMLElement).findByText("Approved · id copied")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText("Failed")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText("None")).toBeTruthy();
    const [openTask] = within(uses).getAllByRole("button", { name: "Open task" });
    await userEvent.click(openTask as HTMLElement);
    expect(navigate).toHaveBeenCalledWith(`/agent/activity/${IDS.tasks.subscriptionAudit}`);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "GitHub" })).toBeNull());
  });

  it("says when an item has not been used", async () => {
    setup({ defaultSection: "credentials" });
    const table = await screen.findByRole("table", { name: "Stored credentials" });
    await userEvent.click(within(table).getByRole("button", { name: "Link wallet" }));
    const sheet = await screen.findByRole("dialog", { name: "Link wallet" });
    expect(await within(sheet).findByText("Not used yet.")).toBeTruthy();
  });

  it("parses sites and words vault failures plainly", () => {
    expect(parseBinding("github.com", "login")).toEqual({ origin: "https://github.com" });
    expect(parseBinding("http://localhost:3000/x", "login")).toEqual({
      origin: "http://localhost:3000",
    });
    expect(parseBinding("build.example.com:2222", "ssh_key")).toEqual({
      host: "build.example.com:2222",
    });
    expect(parseBinding("ftp://example.com", "login")).toBeNull();
    expect(parseBinding("intranet", "login")).toBeNull();
    const c = createFixtureWorld().credentials[0];
    if (c === undefined) throw new Error("no fixture credential");
    const locked = new GatewayRequestError("vault.update", "unavailable", "locked", {
      reason: "locked",
    });
    expect(vaultChangeError(locked, c, "change")).toBe(
      "The vault is locked. Unlock it with Touch ID, then change GitHub again.",
    );
    const scope = new GatewayRequestError(
      "vault.delete",
      "forbidden",
      "vault.delete requires scope operator.admin",
    );
    expect(vaultChangeError(scope, c, "delete")).toBe(
      "Only a device paired as admin can delete vault items.",
    );
    const owned = new GatewayRequestError("vault.delete", "forbidden", "gateway-owned", {
      reason: "gateway_owned",
      kind: "channel",
      setting: "channels",
    });
    expect(vaultChangeError(owned, c, "delete")).toBe(
      "GitHub belongs to the Gateway; remove it in Settings → Channels.",
    );
  });
});

describe("VM mode", () => {
  const guestWorld = (w: Parameters<NonNullable<StoryWorldProps["edit"]>>[0]) => {
    w.devices = [
      ...w.devices,
      {
        id: "dev_guest",
        name: "work-mac",
        platform: "macos",
        role: "node",
        publicKey: "gK3k9vQ2c8Lr0yT5uB7wN1eJ4hF6gD2sA9zP0oK3iM8",
        scopes: ["node"],
        pairedAt: "2026-10-18T09:00:00Z",
        lastSeenAt: "2026-10-18T10:00:00Z",
        revokedAt: null,
      },
    ];
    w.nodes = [
      ...w.nodes,
      {
        id: "node_guest",
        deviceId: "dev_guest",
        kind: "vm-guest",
        status: "online",
        capabilities: [],
        lastHeartbeatAt: "2026-10-18T10:00:00Z",
      },
    ];
  };

  it("shows the defaults and writes each VM setting", async () => {
    const { gateway } = setup({ defaultSection: "vm" }, { edit: guestWorld });
    expect(await screen.findByRole("heading", { level: 2, name: "VM mode" })).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Use a sandbox Mac for tasks" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(
      (screen.getByRole("radio", { name: "Container sandbox" }) as HTMLInputElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: "Paste into the guest only" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByRole("radio", { name: "Host vault" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByText(/No guest has reported yet/)).toBeTruthy();

    await userEvent.click(toggle);
    await waitFor(() => expect(settingValue(gateway(), "vm.enabled")).toBe(true));
    const node = (await screen.findByLabelText(
      "Guest that runs task commands",
    )) as HTMLSelectElement;
    await waitFor(() => expect(node.disabled).toBe(false));
    expect(within(node).getByRole("option", { name: "work-mac" })).toBeTruthy();
    await userEvent.selectOptions(node, "node_guest");
    await waitFor(() => expect(settingValue(gateway(), "vm.guestNodeId")).toBe("node_guest"));
    await userEvent.click(screen.getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(settingValue(gateway(), "vm.clipboard")).toBe("off"));
    await userEvent.click(screen.getByRole("radio", { name: "Guest vault" }));
    await waitFor(() => expect(settingValue(gateway(), "vm.credentials")).toBe("guest"));
  });

  it("shows the guest as vm.updated reports it", async () => {
    const { gateway } = setup({ defaultSection: "vm" });
    await screen.findByText(/No guest has reported yet/);
    const guest = {
      name: "work-mac",
      phase: "running" as const,
      provisioned: true,
      cpus: 4,
      memoryGB: 8,
      diskGB: 80,
      guestOS: "27.0.1",
      username: "psyche",
      shares: [
        {
          name: "Documents",
          hostPath: "/Users/you/Documents",
          readOnly: true,
          guestPath: "/Volumes/Psyche Shares/Documents",
        },
      ],
      vsock: { hostCid: 2, gatewayNodePort: 7001 },
      agent: { connected: true, version: "0.3.0" },
      clipboard: "paste-only" as const,
    };
    act(() => gateway().emit("vm.updated", { nodeId: "node_mac_helper", guest, at: FIXTURE_NOW }));
    const card = await screen.findByRole("article", { name: "Guest work-mac" });
    expect(within(card).getByText("Running")).toBeTruthy();
    expect(within(card).getByText("Documents (read only)")).toBeTruthy();
    expect(within(card).getByText("Connected (0.3.0)")).toBeTruthy();
    act(() =>
      gateway().emit("vm.updated", {
        nodeId: "node_mac_helper",
        guest: { ...guest, phase: "failed", lastError: "disk_full" },
        at: FIXTURE_NOW,
      }),
    );
    expect(await within(card).findByText("Failed")).toBeTruthy();
    expect(within(card).getByText(/The guest stopped: disk_full\./)).toBeTruthy();
  });
});

describe("Data controls", () => {
  it("needs the typed word before resetting memory", async () => {
    const { gateway } = setup({ defaultSection: "data" });
    await userEvent.click(await screen.findByRole("button", { name: "Reset memory…" }));
    const confirm = screen.getByRole("button", { name: "Reset memory" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/Type “reset” to confirm/), "rese");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/Type “reset” to confirm/), "t");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() => expect(callsOf(gateway(), "memory.reset")).toHaveLength(1));
    expect(await screen.findByText(/Memory reset:/)).toBeTruthy();
    expect(screen.queryByText(/training/i)?.textContent).toMatch(/no training toggle/);
  });

  it("pauses memory through memory.pause", async () => {
    const { gateway } = setup({ defaultSection: "data" });
    await userEvent.click(await screen.findByRole("switch", { name: "Pause memory" }));
    await waitFor(() =>
      expect(callsOf(gateway(), "memory.pause")[0]?.params).toEqual({ paused: true }),
    );
    expect(await screen.findByText("Memory paused.")).toBeTruthy();
  });
});

describe("Persona", () => {
  it("picks a bundled creature and records a described change", async () => {
    const { gateway } = setup({ defaultSection: "persona" });
    await userEvent.click(await screen.findByRole("radio", { name: "Owl" }));
    await waitFor(() => expect(settingValue(gateway(), "persona.creatureId")).toBe("owl"));
    await userEvent.type(screen.getByLabelText("Describe a change"), "a tiny scarf");
    await userEvent.click(screen.getByRole("button", { name: "Apply change" }));
    await waitFor(() => expect(settingValue(gateway(), "persona.creature")).toBe("a tiny scarf"));
    expect(screen.getByRole("status").textContent).toMatch(/Saved your description/);
  });
});

describe("Devices", () => {
  it("shows the pairing challenge and approves with owner-chosen scopes", async () => {
    const { gateway } = setup({ defaultSection: "devices", thisDeviceId: IDS.devices.mac });
    expect(await screen.findByText("731-904")).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "Approvals" }));
    await userEvent.click(screen.getByRole("button", { name: "Approve iPad Air" }));
    await waitFor(() =>
      expect(callsOf(gateway(), "devices.approve")[0]?.params).toEqual({
        pairingRequestId: IDS.pairing.ipad,
        scopes: ["operator.read", "operator.write", "operator.approvals"],
      }),
    );
    expect(screen.getByText("This device")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More for MacBook Pro" })).toBeNull();
  });
});

describe("Model & providers", () => {
  it("shows key status as a vault reference and the tool-calling check", async () => {
    const onRunCheck = vi.fn();
    const onChange = vi.fn();
    render(
      <ModelProvidersPanel
        values={sampleSettings()}
        onChange={onChange}
        providers={sampleProviders()}
        ramGb={32}
        onRunCheck={onRunCheck}
      />,
    );
    expect(screen.getByText("Key stored in the vault. Psyche never shows it.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("vault:anthropic-api-key");
    expect(screen.getByText("Chat only: tool-calling check failed")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Run the tool-calling check on ollama/glm-4.7-flash" }),
    );
    expect(onRunCheck).toHaveBeenCalledWith("ollama/glm-4.7-flash");
    await userEvent.selectOptions(screen.getByLabelText(/^Utility/), "ollama/qwen3.8-27b");
    expect(onChange).toHaveBeenCalledWith("models.utility", "ollama/qwen3.8-27b");
    expect(screen.getByText(/This Mac has 32 GB/)).toBeTruthy();
  });

  it("renders loading and error states", () => {
    const view = render(
      <ModelProvidersPanel values={{}} onChange={() => {}} providers={[]} loading />,
    );
    expect(screen.getByRole("status", { name: "Loading model providers" })).toBeTruthy();
    view.rerender(
      <ModelProvidersPanel values={{}} onChange={() => {}} providers={[]} error="timeout" />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(
      /couldn't load model providers \(timeout\)/,
    );
  });
});

describe("Usage", () => {
  it("shows the percent-remaining meter", async () => {
    setup({ defaultSection: "usage", usage: createFixtureWorld().usage });
    const meter = await screen.findByRole("meter", { name: "Budget remaining" });
    expect((meter as HTMLMeterElement).value).toBe(62);
    expect(screen.getAllByText("62% left").length).toBeGreaterThan(0);
  });
});

describe("File access (folder grants live in permissions.policy)", () => {
  const policy = {
    defaultMode: "manual",
    folders: [
      { path: "/Users/me/Notes", mode: "rw" },
      { path: "", mode: "ro" },
      { path: "/x", mode: "rwx" },
    ],
  };

  it("reads well-formed policy folders and falls back to the UI-local key only without a list", () => {
    expect(folderGrants({ "permissions.policy": policy })).toEqual([
      { path: "/Users/me/Notes", access: "rw" },
    ]);
    const legacy = [{ path: "~/Old", access: "ro" }];
    expect(folderGrants({ "permissions.folders": legacy })).toEqual(legacy);
    expect(
      folderGrants({ "permissions.policy": { folders: [] }, "permissions.folders": legacy }),
    ).toEqual([]);
    expect(folderGrants({})).toEqual([]);
  });

  it("writes folders into the policy, keeping its other keys and deduping paths", () => {
    expect(
      policyWithFolders({ "permissions.policy": policy }, [
        { path: "/a", access: "ro" },
        { path: " /a ", access: "rw" },
        { path: "/b", access: "rw" },
      ]),
    ).toEqual({
      defaultMode: "manual",
      folders: [
        { path: "/a", mode: "ro" },
        { path: "/b", mode: "rw" },
      ],
    });
  });

  it("shares a typed folder as a permissions.policy grant the broker applies", async () => {
    const { gateway } = setup(
      { defaultSection: "files" },
      { edit: (w) => Object.assign(w.settings, { "permissions.policy": policy }) },
    );
    const list = await screen.findByRole("list", { name: "Shared folders" });
    expect(within(list).getByText("/Users/me/Notes")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Share a folder"), "/Users/me/Taxes{Enter}");
    await waitFor(() =>
      expect(settingValue(gateway(), "permissions.policy")).toEqual({
        defaultMode: "manual",
        folders: [
          { path: "/Users/me/Notes", mode: "rw" },
          { path: "/Users/me/Taxes", mode: "ro" },
        ],
      }),
    );
    expect(settingCall(gateway(), "permissions.folders")).toBeUndefined();
  });

  it("the Permissions summary lists the policy's folders", async () => {
    setup(
      { defaultSection: "permissions" },
      { edit: (w) => Object.assign(w.settings, { "permissions.policy": policy }) },
    );
    expect(await screen.findByText("/Users/me/Notes")).toBeTruthy();
    expect(screen.getByText("read and write")).toBeTruthy();
  });
});

describe("Settings polish (UI design §3.18, §4.12)", () => {
  it("says connector actions in plain words, with one segmented control per action", async () => {
    expect(actionLabel("gmail.read")).toBe("read threads");
    expect(actionLabel("gmail.send")).toBe("send");
    expect(actionLabel("mcp__notion__create_page")).toBe("create page");
    expect(actionLabel("contacts.write")).toBe("change contacts");
    setup({ defaultSection: "permissions" });
    const list = await screen.findByRole("list", { name: "Gmail actions" });
    expect(within(list).getByText("read threads")).toBeTruthy();
    const segmented = within(list).getByRole("radiogroup", { name: "read threads" });
    expect(
      within(segmented)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("aria-label")),
    ).toEqual(["read threads: Allow", "read threads: Ask", "read threads: Deny"]);
    expect(within(list).queryByText("gmail.read")).toBeNull();
  });

  it("shows no config keys in Channels labels", async () => {
    setup({ defaultSection: "channels" });
    expect(await screen.findByRole("radiogroup", { name: "Direct messages" })).toBeTruthy();
    expect(screen.queryByText(/dmPolicy|requireMention/)).toBeNull();
  });

  it("gives the empty Connectors screen one primary action", async () => {
    setup(
      { defaultSection: "connectors", onConnect: () => {} },
      {
        edit: (w) => {
          w.connectors = [];
        },
      },
    );
    expect(await screen.findByText(/No accounts connected/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Add connector" })).toHaveLength(1);
  });

  it("draws each accent swatch as one radio", async () => {
    setup({ defaultSection: "appearance" });
    const group = await screen.findByRole("radiogroup", { name: "Accent color" });
    expect(within(group).getAllByRole("radio").length).toBe(7);
  });
});

describe("Security settings need approval with presence (security §10)", () => {
  /** The kit's mock Gateway plus #178's flow: the first security write issues a policy card. */
  function approvingGateway(options: { presenceFails?: boolean } = {}) {
    const inner = new MockGateway(
      (() => {
        const w = createFixtureWorld();
        Object.assign(w.settings, sampleSettings());
        return w;
      })(),
      { now: () => FIXTURE_NOW },
    );
    const writes: unknown[] = [];
    const base = inner.world.approvals[0] as ApprovalRequest;
    const client: GatewayClient = {
      async request(method, params, opts) {
        const p = params as { key?: string; value?: unknown; approvalId?: string };
        if (method === "settings.set") writes.push(params);
        if (method === "settings.set" && p.key === "permissions.policy" && !p.approvalId) {
          const { target: _target, ...rest } = base;
          const approval: ApprovalRequest = {
            ...rest,
            id: "ap_policy_change",
            kind: "policy_change",
            summary: "Change permissions.policy",
            details: { setting: p.key, value: p.value },
            requestedBy: { deviceId: "dev_this" } as ApprovalRequest["requestedBy"],
            surfaces: ["desktop", "notification"],
            scopesOffered: ["once"],
            deviceOnly: true,
            requiresAuthentication: true,
            taint: false,
            status: "pending",
            expiresAt: "2099-01-01T00:00:00.000Z",
          };
          inner.world.approvals.push(approval);
          inner.world.answerTokens[approval.id] = "tok_policy";
          inner.emit("approval.created", { approval, answerToken: "tok_policy" });
          throw new GatewayRequestError(method, "approval_required", "Approve the change first", {
            approvalId: approval.id,
          });
        }
        if (method === "approvals.answer" && options.presenceFails) {
          throw new GatewayRequestError(method, "forbidden", "a presence assertion is required", {
            reason: "presence_required",
          });
        }
        return inner.request(method, params, opts);
      },
      subscribe: (l) => inner.subscribe(l),
      connectionState: () => inner.connectionState(),
      onConnectionState: (l) => inner.onConnectionState(l),
    };
    render(
      <GatewayProvider client={client} store={new GatewayStore(client, { now: () => FIXTURE_NOW })}>
        <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
          <SettingsScreen now={NOW} defaultSection="files" />
        </UiSlotsProvider>
      </GatewayProvider>,
    );
    return { writes };
  }

  async function shareFolder() {
    await userEvent.type(await screen.findByLabelText("Share a folder"), "/Users/me/Taxes{Enter}");
    return screen.findByTestId("settings-approval");
  }

  async function approve(banner: HTMLElement) {
    await waitFor(() => expect(within(banner).queryByText("Loading the approval…")).toBeNull());
    await userEvent.click(within(banner).getByText("Allow once", { exact: true }));
    const button = within(banner).getByRole("button", { name: "Allow with scope" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(button);
  }

  it("shows the approval card, then saves with the approvalId once approved", async () => {
    const { writes } = approvingGateway();
    const banner = await shareFolder();
    expect(within(banner).getByText(/Approve this change to “Permission policy”/)).toBeTruthy();
    await approve(banner);
    expect(await screen.findByText("Saved “Permission policy”.")).toBeTruthy();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ key: "permissions.policy", approvalId: "ap_policy_change" });
    expect((writes[1] as { value: unknown }).value).toEqual(
      (writes[0] as { value: unknown }).value,
    );
    expect(screen.queryByTestId("settings-approval")).toBeNull();
  });

  it("says so clearly when this window cannot confirm presence", async () => {
    const { writes } = approvingGateway({ presenceFails: true });
    const banner = await shareFolder();
    await approve(banner);
    expect(await within(banner).findAllByText(presenceUnavailable())).not.toHaveLength(0);
    expect(writes).toHaveLength(1);
  });
});

describe("Browser (real-Chrome mode, I13)", () => {
  it("the switch writes browser.realChrome and the profile opens through the shell", async () => {
    const opened: string[] = [];
    const { gateway } = setup({
      defaultSection: "browser",
      onOpenRealChromeProfile: async (profile) => {
        opened.push(profile);
        return { path: `/Users/me/.psyche/browser/real-chrome/${profile}` };
      },
    });
    await userEvent.click(
      await screen.findByRole("switch", {
        name: `Let tasks use the Psyche profile (${PERSONA.name})`,
      }),
    );
    await waitFor(() =>
      expect(settingValue(gateway(), "browser.realChrome")).toEqual({ enabled: true }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Open the profile in Chrome" }));
    expect(opened).toEqual(["default"]);
    expect(
      await screen.findByText(
        "Opened /Users/me/.psyche/browser/real-chrome/default in Google Chrome.",
      ),
    ).toBeTruthy();
  });

  it("Web Bot Auth: creates and rotates the key, and writes the switch and directory URL", async () => {
    const { gateway } = setup({ defaultSection: "browser" });
    expect(await screen.findByText("No key yet")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Create key" }));
    expect(
      await screen.findByText("Key created. Publish the directory, then enter its address above."),
    ).toBeTruthy();
    expect(callsOf(gateway(), "browser.botAuth.rotate")).toHaveLength(1);
    const first = (await screen.findByTestId("bot-auth-fingerprint")).textContent;
    expect(first).toMatch(/^fixture-key-/);

    await userEvent.click(screen.getByRole("switch", { name: "Sign requests for sites that ask" }));
    await waitFor(() =>
      expect(settingValue(gateway(), "browser.botAuth")).toEqual({ enabled: true }),
    );
    const url = screen.getByLabelText("Key directory URL");
    await userEvent.type(
      url,
      "https://psyche.example/.well-known/http-message-signatures-directory{Enter}",
    );
    await waitFor(() =>
      expect(
        callsOf(gateway(), "settings.set")
          .filter((c) => (c.params as { key: string }).key === "browser.botAuth")
          .map((c) => (c.params as { value: unknown }).value)
          .at(-1),
      ).toMatchObject({
        signatureAgent: "https://psyche.example/.well-known/http-message-signatures-directory",
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    expect(
      await screen.findByText(
        "A new key is in place and the old one no longer signs. Update the directory you publish.",
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("bot-auth-fingerprint").textContent).not.toBe(first),
    );
  });

  it("without the desktop app it says where to open the profile", async () => {
    setup({ defaultSection: "browser" });
    expect(
      await screen.findByText("Open it from the Psyche app on the Mac that runs the Gateway."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open the profile in Chrome" })).toBeNull();
  });
});

describe("Credentials: Stripe Link payments and 1Password", () => {
  it("shows Link payment methods and recent spends, brand and last4 only", async () => {
    const { gateway } = setup({ defaultSection: "credentials" });
    const table = await screen.findByRole("table", { name: "Recent payments" });
    const methods = screen.getByRole("list", { name: "Link payment methods" });
    expect(within(methods).getByText("Visa •••• 1881")).toBeTruthy();
    expect(within(methods).getByText("Work card")).toBeTruthy();
    expect(within(table).getByText("Lumen Air")).toBeTruthy();
    expect(within(table).getByText("$412.80")).toBeTruthy();
    expect(within(table).getByText("held")).toBeTruthy();
    expect(within(table).getByText(/SB-1001/)).toBeTruthy();
    expect(within(table).getByText("charged")).toBeTruthy();
    expect(within(table).getByText("$18.99 · $18.99 refunded")).toBeTruthy();
    expect(callsOf(gateway(), "vault.payments.list")[0]?.params).toEqual({ limit: 20 });
  });

  it("reloads the spends on vault.payment.updated", async () => {
    const { gateway } = setup({ defaultSection: "credentials" });
    const table = await screen.findByRole("table", { name: "Recent payments" });
    const g = gateway();
    const held = g.world.payments?.[0];
    if (held === undefined) throw new Error("no fixture payment");
    const captured = {
      ...held,
      payment: { state: "captured" as const, held: 0, captured: held.amount, refunded: 0 },
    };
    g.world.payments = [captured, ...(g.world.payments ?? []).slice(1)];
    g.emit("vault.payment.updated", { payment: captured });
    await waitFor(() => expect(within(table).queryByText("held")).toBeNull());
    expect(within(table).getAllByText("charged")).toHaveLength(2);
  });

  it("explains that Stripe Link is not set up", async () => {
    setup(
      { defaultSection: "credentials" },
      {
        edit: (w) => {
          delete w.linkMethods;
        },
      },
    );
    expect(await screen.findByText(/Stripe Link is not set up/)).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Recent payments" })).toBeNull();
  });

  it("links a 1Password item by reference and keeps its values out of the edit form", async () => {
    const { gateway } = setup({ defaultSection: "credentials" });
    const table = await screen.findByRole("table", { name: "Stored credentials" });
    await userEvent.click(screen.getByRole("button", { name: "More ways to add" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Connect 1Password" }));
    const form = screen.getByRole("form", { name: "Link a 1Password item" });
    await userEvent.type(within(form).getByLabelText("Name"), "Fastmail");
    await userEvent.type(within(form).getByLabelText("1Password vault"), "Private");
    await userEvent.type(within(form).getByLabelText("1Password item"), "Fastmail");
    await userEvent.type(within(form).getByLabelText("Only for this site"), "app.fastmail.com");
    await userEvent.click(within(form).getByRole("button", { name: "Link item" }));
    await waitFor(() => expect(callsOf(gateway(), "vault.linkExternal")).toHaveLength(1));
    expect(callsOf(gateway(), "vault.linkExternal")[0]?.params).toEqual({
      source: "1password",
      kind: "login",
      name: "Fastmail",
      bindings: [{ origin: "https://app.fastmail.com" }],
      ref: { vault: "Private", item: "Fastmail" },
    });
    expect(await within(table).findByText("Fastmail")).toBeTruthy();
    expect(within(table).getByText("in 1Password")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Link a 1Password item" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Edit Fastmail" }));
    const edit = screen.getByRole("form", { name: "Edit Fastmail" });
    expect(within(edit).queryByLabelText("New password")).toBeNull();
    expect(within(edit).getByText(/The values stay in 1Password/)).toBeTruthy();
  });

  it("explains when 1Password is not set up on the Gateway", async () => {
    const { gateway } = setup({ defaultSection: "credentials" });
    await screen.findByRole("table", { name: "Stored credentials" });
    gateway().failNext("vault.linkExternal", "unavailable", "1Password is not configured");
    await userEvent.click(screen.getByRole("button", { name: "More ways to add" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Connect 1Password" }));
    const form = screen.getByRole("form", { name: "Link a 1Password item" });
    await userEvent.type(within(form).getByLabelText("Name"), "GitHub");
    await userEvent.type(within(form).getByLabelText("1Password vault"), "Private");
    await userEvent.type(within(form).getByLabelText("1Password item"), "GitHub");
    await userEvent.click(within(form).getByRole("button", { name: "Link item" }));
    expect(await within(form).findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringMatching(/1Password is not set up on the Gateway/),
    );
  });

  it("links a Bitwarden item by id or name, and says where it lives", async () => {
    const { gateway } = setup({ defaultSection: "credentials" });
    const table = await screen.findByRole("table", { name: "Stored credentials" });
    await userEvent.click(screen.getByRole("button", { name: "More ways to add" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Connect Bitwarden" }));
    const form = screen.getByRole("form", { name: "Link a Bitwarden item" });
    expect(within(form).queryByLabelText("1Password vault")).toBeNull();
    expect(within(form).getByText(/Cards and identities are never read/)).toBeTruthy();
    await userEvent.selectOptions(within(form).getByLabelText("Kind"), "api_key");
    await userEvent.type(within(form).getByLabelText("Name"), "Example API");
    await userEvent.type(within(form).getByLabelText("Bitwarden item id or name"), "Example API");
    await userEvent.type(within(form).getByLabelText("Only for this site"), "api.example.com");
    await userEvent.click(within(form).getByRole("button", { name: "Link item" }));
    await waitFor(() => expect(callsOf(gateway(), "vault.linkExternal")).toHaveLength(1));
    expect(callsOf(gateway(), "vault.linkExternal")[0]?.params).toEqual({
      source: "bitwarden",
      kind: "api_key",
      name: "Example API",
      bindings: [{ origin: "https://api.example.com" }],
      ref: { item: "Example API" },
    });
    expect(await within(table).findByText("Example API")).toBeTruthy();
    expect(within(table).getByText("in Bitwarden")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Edit Example API" }));
    const edit = screen.getByRole("form", { name: "Edit Example API" });
    expect(within(edit).queryByLabelText("New key")).toBeNull();
    expect(within(edit).getByText(/The values stay in Bitwarden/)).toBeTruthy();
  });

  it("explains what the Gateway needs before Bitwarden works", async () => {
    const { gateway } = setup({ defaultSection: "credentials" });
    await screen.findByRole("table", { name: "Stored credentials" });
    gateway().failNext("vault.linkExternal", "unavailable", "Bitwarden is not configured");
    await userEvent.click(screen.getByRole("button", { name: "More ways to add" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Connect Bitwarden" }));
    const form = screen.getByRole("form", { name: "Link a Bitwarden item" });
    await userEvent.type(within(form).getByLabelText("Name"), "GitHub");
    await userEvent.type(within(form).getByLabelText("Bitwarden item id or name"), "GitHub");
    await userEvent.click(within(form).getByRole("button", { name: "Link item" }));
    expect(await within(form).findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringMatching(/Bitwarden is not set up on the Gateway.*bw unlock/),
    );
  });
});

describe("Settings → Connectors connects for real (#505)", () => {
  it("runs connectors.connect, waits for the sign-in and lists the account from the Gateway", async () => {
    let gw: MockGateway | null = null;
    const openExternal = vi.fn(async (_url: string) => {});
    render(
      <StoryWorld
        edit={(w) => {
          w.connectors = [];
        }}
        onGateway={(g) => (gw = g)}
        slots={{ openExternal }}
      >
        <ConnectorsSection />
      </StoryWorld>,
    );
    // The list loads again once the mock connection opens; click the settled empty state.
    await waitFor(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Add connector" }));
      await userEvent.click(screen.getByRole("button", { name: /^Google/ }));
      expect(screen.getByRole("button", { name: "Continue to sign in" })).toBeTruthy();
    });
    await userEvent.click(screen.getByRole("button", { name: "Continue to sign in" }));
    const g = gw as unknown as MockGateway;
    await waitFor(() =>
      expect(g.calls.find((c) => c.method === "connectors.connect")?.params).toMatchObject({
        catalogueId: "google",
        scopeMode: "read",
      }),
    );
    expect(await screen.findByTestId("connect-signing-in")).toBeTruthy();
    expect(openExternal).toHaveBeenCalledOnce();
    const id = g.world.connectors.at(-1)?.id ?? "";
    act(() => g.finishConnectorSignIn(id, "connected", "owner@gmail.com"));
    expect(await screen.findByText(/is connected as owner@gmail\.com\./)).toBeTruthy();
    // connectors.updated refreshed connectors.list: the account is listed.
    await waitFor(() => expect(screen.getAllByText("owner@gmail.com").length).toBeGreaterThan(0));
  });
});
