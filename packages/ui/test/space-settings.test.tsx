import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { SPACE_IDS, withSpaces } from "../src/fixtures/spaces.ts";
import { SpacePage } from "../src/spaces/SpacePage.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Space settings (`spaces.settings.set`): default mode, connector scope, automations' writes. */

afterEach(cleanup);

let gateway: MockGateway | undefined;
const calls = (method: string) => {
  if (gateway === undefined) throw new Error("gateway not ready");
  return gateway.calls.filter((c) => c.method === method);
};
const gw = () => {
  if (gateway === undefined) throw new Error("gateway not ready");
  return gateway;
};

function renderSpace(slots: Record<string, unknown> = { pickFolder: () => Promise.resolve(null) }) {
  return render(
    <StoryWorld
      edit={withSpaces}
      onGateway={(g) => {
        gateway = g;
      }}
      slots={{ navigate: vi.fn(), ...slots }}
    >
      <SpacePage spaceId={SPACE_IDS.kitchen} />
    </StoryWorld>,
  );
}

const section = async () => within(await screen.findByTestId("space-settings"));
const MODE = "Default permission mode";
const KITCHEN_WRITE = "Let automations change files in ~/Projects/Kitchen";

describe("Space settings", () => {
  it("loads the saved values and explains the chosen mode in one sentence", async () => {
    renderSpace();
    const s = await section();
    const mode = s.getByRole("combobox", { name: MODE }) as HTMLSelectElement;
    expect(mode.value).toBe("inherit");
    expect(s.getByText("Chats here use your global permission mode.")).toBeTruthy();
    expect(
      (s.getByRole("combobox", { name: "Connectors in this Space" }) as HTMLSelectElement).value,
    ).toBe("all");
    // Off by default (SP8).
    expect(s.getByRole("checkbox", { name: KITCHEN_WRITE }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("changes the default mode, and back to the global mode with null", async () => {
    renderSpace();
    const s = await section();
    fireEvent.change(s.getByRole("combobox", { name: MODE }), { target: { value: "auto" } });
    await waitFor(() => expect(calls("spaces.settings.set")).toHaveLength(1));
    expect(calls("spaces.settings.set")[0]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      defaultPermissionMode: "auto",
    });
    expect(
      await screen.findByText(/Routine actions inside your grants run on their own/),
    ).toBeTruthy();

    fireEvent.change(s.getByRole("combobox", { name: MODE }), { target: { value: "inherit" } });
    await waitFor(() => expect(calls("spaces.settings.set")).toHaveLength(2));
    expect(calls("spaces.settings.set")[1]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      defaultPermissionMode: null,
    });
  });

  it("limits connectors to a chosen list, edits it and lifts the limit", async () => {
    renderSpace();
    const s = await section();
    const known = gw().world.connectors;
    expect(known.length).toBeGreaterThan(1);
    fireEvent.change(s.getByRole("combobox", { name: "Connectors in this Space" }), {
      target: { value: "some" },
    });
    await waitFor(() => expect(calls("spaces.settings.set")).toHaveLength(1));
    expect(calls("spaces.settings.set")[0]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      connectorScope: known.map((c) => c.id),
    });

    const first = known[0];
    if (first === undefined) throw new Error("no connector fixture");
    fireEvent.click(await s.findByRole("checkbox", { name: `Use ${first.label} in this Space` }));
    await waitFor(() => expect(calls("spaces.settings.set")).toHaveLength(2));
    expect(calls("spaces.settings.set")[1]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      connectorScope: known.slice(1).map((c) => c.id),
    });

    fireEvent.change(s.getByRole("combobox", { name: "Connectors in this Space" }), {
      target: { value: "all" },
    });
    await waitFor(() => expect(calls("spaces.settings.set")).toHaveLength(3));
    expect(calls("spaces.settings.set")[2]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      connectorScope: null,
    });
  });

  it("lets automations write in one folder, then turns it off", async () => {
    renderSpace();
    const s = await section();
    expect(
      s.getByText(
        /Ticking one lets an automation that runs on its own create, edit and delete files there/,
      ),
    ).toBeTruthy();
    fireEvent.click(s.getByRole("checkbox", { name: KITCHEN_WRITE }));
    await waitFor(() => expect(calls("spaces.settings.set")).toHaveLength(1));
    expect(calls("spaces.settings.set")[0]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      automationsWrite: [{ path: "~/Projects/Kitchen", allow: true }],
    });
    await waitFor(() =>
      expect(s.getByRole("checkbox", { name: KITCHEN_WRITE }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    fireEvent.click(s.getByRole("checkbox", { name: KITCHEN_WRITE }));
    await waitFor(() => expect(calls("spaces.settings.set")).toHaveLength(2));
    expect(calls("spaces.settings.set")[1]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      automationsWrite: [{ path: "~/Projects/Kitchen", allow: false }],
    });
  });

  it("shows the Gateway's refusal in its own words and keeps the saved value", async () => {
    renderSpace();
    const s = await section();
    gw().failNext("spaces.settings.set", "forbidden", "Let automations change files on your Mac", {
      reason: "host_only",
    });
    fireEvent.click(s.getByRole("checkbox", { name: KITCHEN_WRITE }));
    const alert = await s.findByRole("alert");
    expect(alert.textContent).toContain("Let automations change files on your Mac");
    expect(s.getByRole("checkbox", { name: KITCHEN_WRITE }).getAttribute("aria-checked")).toBe(
      "false",
    );
    // Not an admin problem: the controls stay usable.
    expect((s.getByRole("combobox", { name: MODE }) as HTMLSelectElement).disabled).toBe(false);
  });

  it("locks the section with the admin note when this device lacks admin", async () => {
    renderSpace();
    const s = await section();
    gw().failNext("spaces.settings.set", "forbidden", "missing scope operator.admin");
    fireEvent.change(s.getByRole("combobox", { name: MODE }), { target: { value: "manual" } });
    expect(await s.findByText(/Change it from a device paired as admin/)).toBeTruthy();
    expect((s.getByRole("combobox", { name: MODE }) as HTMLSelectElement).disabled).toBe(true);
    expect(s.getByRole("checkbox", { name: KITCHEN_WRITE }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("is read-only with the reason in a client of another computer's Gateway", async () => {
    renderSpace({ pickFolder: () => Promise.resolve(null), remoteHost: "Studio Mac" });
    const s = await section();
    expect(
      s.getByText(
        "This Space lives on Studio Mac. Change its settings in Psyche on that computer.",
      ),
    ).toBeTruthy();
    expect((s.getByRole("combobox", { name: MODE }) as HTMLSelectElement).disabled).toBe(true);
    expect(
      (s.getByRole("combobox", { name: "Connectors in this Space" }) as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(s.getByRole("checkbox", { name: KITCHEN_WRITE }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    fireEvent.change(s.getByRole("combobox", { name: MODE }), { target: { value: "auto" } });
    expect(calls("spaces.settings.set")).toHaveLength(0);
  });

  it("is read-only where there is no desktop folder picker", async () => {
    renderSpace({});
    const s = await section();
    expect(
      s.getByText(
        "Change these settings in the Psyche desktop app, on the computer where Psyche runs.",
      ),
    ).toBeTruthy();
    expect((s.getByRole("combobox", { name: MODE }) as HTMLSelectElement).disabled).toBe(true);
  });
});
