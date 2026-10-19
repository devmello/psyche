import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway, RecordedCall } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS, PERSONA } from "../src/fixtures/index.ts";
import { ChannelsPanel } from "../src/screens/settings/ChannelsSection.tsx";
import { CARD_REFUSAL } from "../src/screens/settings/CredentialsSection.tsx";
import { ModelProvidersPanel } from "../src/screens/settings/ModelSection.tsx";
import {
  SettingsScreen,
  type SettingsScreenProps,
} from "../src/screens/settings/SettingsScreen.tsx";
import { sampleProviders, sampleSettings } from "../src/screens/settings/sample-data.ts";
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
    expect(items).toHaveLength(15);
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
    await userEvent.click(await screen.findByRole("radio", { name: "Compact" }));
    expect(await screen.findByText(/Psyche couldn't save appearance.density/)).toBeTruthy();
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
    const table = await screen.findByRole("table", { name: "Notion actions" });
    expect(within(table).getByRole("rowheader", { name: "mcp__notion__search" })).toBeTruthy();
    await userEvent.click(within(table).getByRole("radio", { name: "Deny mcp__notion__search" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Remove Gmail" }));
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: IDS.connectors.gmail }));
    expect(screen.getAllByText("Trust: community")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Connect an account" }));
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
    const row = screen.getByRole("row", { name: /1Password/ });
    expect(within(row).getByText("Off (fixed)")).toBeTruthy();
    expect(within(row).queryByRole("radio")).toBeNull();
    expect(screen.getAllByText("Click only (fixed)")).toHaveLength(2);
    await userEvent.click(screen.getByRole("radio", { name: "Notes: Read and interact" }));
    await waitFor(() => {
      const apps = settingValue(gateway(), "computerUse.apps") as { id: string; tier: string }[];
      expect(apps.find((a) => a.id === "com.apple.Notes")?.tier).toBe("interact");
    });
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
    expect(within(table).getByText("github-login")).toBeTruthy();
    expect(within(table).getByText("github.com")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add item" }));
    expect(screen.getByText(CARD_REFUSAL)).toBeTruthy();
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
    setup({ defaultSection: "credentials" });
    await screen.findByRole("table", { name: "Stored credentials" });
    await userEvent.click(screen.getByRole("button", { name: "Add item" }));
    const form = screen.getByRole("form", { name: "Add a credential" });
    await userEvent.type(within(form).getByLabelText("Name"), "Visa");
    await userEvent.type(within(form).getByLabelText("Username"), "you");
    await userEvent.type(within(form).getByLabelText("Password"), "4111 1111 1111 1111");
    await userEvent.click(within(form).getByRole("button", { name: "Store in vault" }));
    expect(await screen.findByText(/looks like a card, bank or ID number/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("4111 1111 1111 1111");
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
    expect(screen.queryByRole("button", { name: "Revoke MacBook Pro" })).toBeNull();
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
    expect(screen.getByText(/Key stored in the vault as vault:anthropic-api-key/)).toBeTruthy();
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
