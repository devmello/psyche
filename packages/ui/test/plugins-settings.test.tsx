import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { PluginsSection } from "../src/screens/settings/PluginsSection.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings → Skills → Plugins: list, the on/off switch over `plugins.setEnabled`, remove, states. */

type Edit = ComponentProps<typeof StoryWorld>["edit"];

function setup(edit?: Edit, onPickFolder?: () => Promise<string | null>): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld edit={edit} onGateway={(g) => (gw = g)}>
      <PluginsSection {...(onPickFolder ? { onPickFolder } : {})} />
    </StoryWorld>,
  );
  return () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw;
  };
}

/** The methods the Gateway was called with, in order. */
function methods(gateway: MockGateway): string[] {
  return gateway.calls.map((c) => c.method);
}

/** The `plugins.setEnabled` calls made so far, as `[name, enabled]`. */
function toggles(gateway: MockGateway): [string, boolean][] {
  return gateway.calls
    .filter((c) => c.method === "plugins.setEnabled")
    .map((c) => {
      const p = c.params as { name: string; enabled: boolean };
      return [p.name, p.enabled];
    });
}

describe("Settings → Plugins", () => {
  it("lists each plugin with its version, source, what it adds and its status", async () => {
    setup();
    const notes = await screen.findByTestId("plugin-meeting-notes");
    expect(within(notes).getByText("meeting-notes")).toBeTruthy();
    expect(within(notes).getByText(/v1\.2\.0/)).toBeTruthy();
    expect(within(notes).getByText(/Adds: context and a step at the end of each run/)).toBeTruthy();
    expect(
      within(notes).getByText(/From \/opt\/psyche-fixtures\/plugins\/meeting-notes/),
    ).toBeTruthy();
    expect(within(notes).getByText(/Running/)).toBeTruthy();

    const check = screen.getByTestId("plugin-citation-check");
    expect(within(check).getByText(/Stopped with an error/)).toBeTruthy();
    expect(within(check).getByText("The plugin process stopped answering.")).toBeTruthy();

    const guard = screen.getByTestId("plugin-tone-guard");
    expect(within(guard).getByText(/Switched off/)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "tone-guard on" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("switches a plugin on and off through plugins.setEnabled with its id", async () => {
    const gateway = setup();
    const toggle = await screen.findByRole("switch", { name: "tone-guard on" });
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "tone-guard on" }).getAttribute("aria-checked"),
      ).toBe("true"),
    );
    await userEvent.click(screen.getByRole("switch", { name: "meeting-notes on" }));
    await waitFor(() =>
      expect(toggles(gateway())).toEqual([
        ["tone-guard", true],
        ["meeting-notes", false],
      ]),
    );
  });

  it("says it is waiting when the Gateway holds the switch for approval, and does not retry", async () => {
    const gateway = setup();
    const toggle = await screen.findByRole("switch", { name: "tone-guard on" });
    gateway().failNext("plugins.setEnabled", "approval_required", "needs approval", {
      approvalId: "ap_plugin_1",
    });
    await userEvent.click(toggle);
    expect(await screen.findByText("Waiting for your approval on this device.")).toBeTruthy();
    expect(toggles(gateway())).toEqual([["tone-guard", true]]);
    expect(screen.getByRole("switch", { name: "tone-guard on" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("removes a plugin after the confirm dialog", async () => {
    const gateway = setup();
    await userEvent.click(await screen.findByRole("button", { name: "More for tone-guard" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove tone-guard?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByTestId("plugin-tone-guard")).toBeNull());
    expect(gateway().calls.map((c) => c.method)).toContain("plugins.remove");
  });

  it("shows an empty state when no plugin is installed", async () => {
    setup((world) => {
      world.plugins = [];
    });
    expect(await screen.findByText("No plugins are installed.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows the error with a retry when the list cannot load", async () => {
    render(
      <StoryWorld
        onGateway={(g) => g.failNext("plugins.list", "unavailable", "the Gateway is not reachable")}
      >
        <PluginsSection />
      </StoryWorld>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Plugins could not be loaded\./);
    await userEvent.click(
      within(alert.parentElement as HTMLElement).getByRole("button", { name: "Retry" }),
    );
    expect(await screen.findByTestId("plugin-meeting-notes")).toBeTruthy();
  });

  it("says plugins are off on this Gateway when the admin switch is off", async () => {
    setup((world) => {
      world.pluginsEnabled = false;
    });
    expect(
      await screen.findByText("Plugins are switched off on this Gateway, so none of them run."),
    ).toBeTruthy();
  });

  it("shows how many skills, commands, MCP servers and hooks a plugin adds", async () => {
    setup();
    const notes = await screen.findByTestId("plugin-meeting-notes");
    expect(within(notes).getByText("Includes: 2 skills, 1 command, and 1 hook")).toBeTruthy();
    expect(within(screen.getByTestId("plugin-tone-guard")).queryByText(/Includes:/)).toBeNull();
  });

  it("starts an install from the picked folder through plugins.proposeInstall", async () => {
    const pick = vi.fn(async () => "/Users/me/plugins/neat");
    const gateway = setup(undefined, pick);
    await userEvent.click(await screen.findByRole("button", { name: "Install from folder…" }));
    await waitFor(() => {
      const c = gateway().calls.filter((x) => x.method === "plugins.proposeInstall");
      expect(c.map((x) => x.params)).toEqual([{ path: "/Users/me/plugins/neat" }]);
    });
  });

  it("does not call proposeInstall when the folder chooser is cancelled", async () => {
    const gateway = setup(undefined, async () => null);
    await userEvent.click(await screen.findByRole("button", { name: "Install from folder…" }));
    await screen.findByTestId("plugin-meeting-notes");
    expect(gateway().calls.some((x) => x.method === "plugins.proposeInstall")).toBe(false);
  });

  it("installs the plugin only after the owner approves its card, then lists it", async () => {
    const pick = vi.fn(async () => "/Users/me/plugins/neat");
    const gateway = setup(undefined, pick);
    await userEvent.click(await screen.findByRole("button", { name: "Install from folder…" }));
    const card = await screen.findByRole("button", { name: "Allow with scope" });
    expect(methods(gateway())).not.toContain("plugins.install");
    await waitFor(() => expect((card as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(card);
    await waitFor(() => expect(methods(gateway())).toContain("plugins.install"));
    const install = gateway().calls.find((c) => c.method === "plugins.install");
    const approval = gateway().world.approvals.find((a) => a.kind === "skill_install");
    expect(install?.params).toEqual({
      proposalId: expect.any(String),
      approvalId: approval?.id,
    });
    expect(await screen.findByTestId("plugin-neat")).toBeTruthy();
  });

  it("installs nothing when the owner denies the card", async () => {
    const pick = vi.fn(async () => "/Users/me/plugins/neat");
    const gateway = setup(undefined, pick);
    await userEvent.click(await screen.findByRole("button", { name: "Install from folder…" }));
    const deny = await screen.findByRole("button", { name: "Deny" });
    await waitFor(() => expect((deny as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(deny);
    await waitFor(() =>
      expect(gateway().world.approvals.some((a) => a.kind === "skill_install")).toBe(true),
    );
    await waitFor(() =>
      expect(gateway().world.approvals.find((a) => a.kind === "skill_install")?.status).toBe(
        "denied",
      ),
    );
    expect(methods(gateway())).not.toContain("plugins.install");
    expect(screen.queryByTestId("plugin-neat")).toBeNull();
  });

  it("shows the error line when the install fails after approval", async () => {
    const pick = vi.fn(async () => "/Users/me/plugins/neat");
    const gateway = setup(undefined, pick);
    gateway().failNext("plugins.install", "unavailable", "the plugin store is locked");
    await userEvent.click(await screen.findByRole("button", { name: "Install from folder…" }));
    const card = await screen.findByRole("button", { name: "Allow with scope" });
    await waitFor(() => expect((card as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(card);
    expect(
      await screen.findByText("The plugin didn't install. the plugin store is locked"),
    ).toBeTruthy();
    expect(screen.queryByTestId("plugin-neat")).toBeNull();
  });

  it("hides the install button when there is no folder chooser (web)", async () => {
    setup();
    await screen.findByTestId("plugin-meeting-notes");
    expect(screen.queryByRole("button", { name: "Install from folder…" })).toBeNull();
  });
});
