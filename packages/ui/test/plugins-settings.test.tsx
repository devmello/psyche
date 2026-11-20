import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { PluginsSection } from "../src/screens/settings/PluginsSection.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings → Skills → Plugins: list, the on/off switch over `plugins.setEnabled`, remove, states. */

type Edit = ComponentProps<typeof StoryWorld>["edit"];

function setup(edit?: Edit): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld edit={edit} onGateway={(g) => (gw = g)}>
      <PluginsSection />
    </StoryWorld>,
  );
  return () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw;
  };
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
});
