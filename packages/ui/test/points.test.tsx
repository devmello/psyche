import { PointsCardStrings, type PointsWindow } from "@psyche/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { en } from "../src/i18n/messages/index.ts";
import { CATALOGUES } from "../src/i18n/messages/locales/index.ts";
import { pointsCardStrings } from "../src/points/card-strings.ts";
import { PointsProvider, usePoints } from "../src/points/PointsContext.tsx";
import { PointsOfferCard } from "../src/points/PointsOfferCard.tsx";
import { PointsSettingsGroup } from "../src/points/PointsSettings.tsx";
import { CommandPalette } from "../src/shell/CommandPalette.tsx";
import type { PointsHelperState, PointsPort } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/**
 * Psyche points, W8 (docs/design/psyche-points-2026.md §6, §9): the start sheet, its permission
 * row, the Chat offer card, the ⌘K action and the helper's card strings, against the mock Gateway.
 */

afterEach(() => cleanup());

const win = (over: Partial<PointsWindow> & Pick<PointsWindow, "ref">): PointsWindow => ({
  app: { bundleId: "com.apple.Safari", name: "Safari" },
  title: "IRS Free File",
  frontmost: false,
  ...over,
});

const WINDOWS: PointsWindow[] = [
  win({ ref: "w1", frontmost: true }),
  win({
    ref: "w2",
    app: { bundleId: "com.apple.Terminal", name: "Terminal" },
    title: "zsh",
    refusal: "terminal_or_ide",
  }),
];

const helper = (over: Partial<PointsHelperState> = {}): PointsHelperState => ({
  helper: "online",
  accessibility: "granted",
  screenRecording: "granted",
  ...over,
});

/** A port that answers `state`; Allow flips Accessibility to granted. */
function fakePort(state: PointsHelperState): PointsPort & { requests: string[] } {
  let current = state;
  const requests: string[] = [];
  return {
    requests,
    helperStatus: () => Promise.resolve(current),
    helperRequest: (kind) => {
      requests.push(kind);
      current = { ...current, [kind]: "granted" };
      return Promise.resolve(current);
    },
  };
}

interface SetupOptions {
  port?: PointsPort | undefined;
  remoteHost?: string;
  enabled?: boolean;
  hostOs?: "macos" | "linux";
  children?: ReactElement;
}

function setup(o: SetupOptions = {}) {
  const gateway: { current: MockGateway | null } = { current: null };
  const edit = (w: FixtureWorld) => {
    w.hostOs = o.hostOs ?? "macos";
    w.settings["points.enabled"] = o.enabled ?? true;
    w.pointsWindows = WINDOWS;
  };
  const view = render(
    <StoryWorld
      edit={edit}
      onGateway={(g) => {
        gateway.current = g;
      }}
      slots={{
        ...("port" in o ? { points: o.port } : { points: fakePort(helper()) }),
        ...(o.remoteHost === undefined ? {} : { remoteHost: o.remoteHost }),
      }}
    >
      <PointsProvider>{o.children ?? <OpenButton />}</PointsProvider>
    </StoryWorld>,
  );
  return { ...view, gateway: () => gateway.current as MockGateway };
}

function OpenButton({ goal, window }: { goal?: string; window?: string }): ReactElement {
  const points = usePoints();
  return (
    <button
      type="button"
      onClick={() =>
        points.open({
          entry: "tray",
          ...(goal === undefined ? {} : { goal }),
          ...(window === undefined ? {} : { window }),
        })
      }
    >
      open points
    </button>
  );
}

const openSheet = async () => {
  await userEvent.click(screen.getByRole("button", { name: "open points" }));
  return screen.findByTestId("points-sheet");
};

describe("the start sheet's permission row", () => {
  it("shows the Accessibility row with Allow while it is missing, and Start waits", async () => {
    const port = fakePort(helper({ accessibility: "not_determined" }));
    setup({ port });
    const sheet = await openSheet();
    const row = await within(sheet).findByTestId("points-permission");
    expect(within(row).getByText("Accessibility")).toBeTruthy();
    await userEvent.click(await within(sheet).findByRole("radio", { name: /Safari/ }));
    const start = within(sheet).getByRole("button", { name: "Start pointing" });
    expect((start as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(within(row).getByRole("button", { name: /Allow/ }));
    expect(port.requests).toEqual(["accessibility"]);
    await waitFor(() => expect(within(sheet).queryByTestId("points-permission")).toBeNull());
    expect((start as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides the row when Accessibility is granted", async () => {
    setup({ port: fakePort(helper()) });
    const sheet = await openSheet();
    await within(sheet).findByRole("radio", { name: /Safari/ });
    expect(within(sheet).queryByTestId("points-permission")).toBeNull();
    expect(within(sheet).queryByText("Accessibility")).toBeNull();
  });

  it("says the helper is offline instead of Granted when it is not connected", async () => {
    setup({ port: fakePort(helper({ helper: "offline", accessibility: "not_determined" })) });
    const sheet = await openSheet();
    const row = await within(sheet).findByTestId("points-permission");
    expect(within(row).queryByText("Granted")).toBeNull();
    expect(within(row).queryByRole("button", { name: /Allow/ })).toBeNull();
  });
});

describe("where Psyche points is offered", () => {
  it("opens the sheet on the Host's own desktop with the setting on (positive control)", async () => {
    setup();
    expect(await openSheet()).toBeTruthy();
  });

  it("is hidden in a window onto another Mac's Gateway", async () => {
    setup({ remoteHost: "Studio Mac" });
    await userEvent.click(screen.getByRole("button", { name: "open points" }));
    await waitFor(() => expect(screen.queryByTestId("points-sheet")).toBeNull());
    // The Gateway is never asked for windows either.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is hidden without the desktop's permission port", async () => {
    setup({ port: undefined });
    await userEvent.click(screen.getByRole("button", { name: "open points" }));
    expect(screen.queryByTestId("points-sheet")).toBeNull();
  });

  it("is hidden while points.enabled is off", async () => {
    setup({ enabled: false });
    await userEvent.click(screen.getByRole("button", { name: "open points" }));
    expect(screen.queryByTestId("points-sheet")).toBeNull();
  });

  it("is hidden when the Host is not a Mac", async () => {
    setup({ hostOs: "linux" });
    await userEvent.click(screen.getByRole("button", { name: "open points" }));
    expect(screen.queryByTestId("points-sheet")).toBeNull();
  });
});

describe("the sheet", () => {
  it("lists windows, keeps a refused one listed with its reason, and starts the chosen one", async () => {
    const { gateway } = setup();
    const sheet = await openSheet();
    const safari = await within(sheet).findByRole("radio", { name: /Safari/ });
    const terminal = within(sheet).getByRole("radio", { name: /Terminal/ });
    expect((terminal as HTMLInputElement).disabled).toBe(true);
    expect(within(sheet).getByText("Terminals and code editors aren't forms.")).toBeTruthy();
    await userEvent.click(safari);
    await userEvent.type(within(sheet).getByRole("textbox"), "2026 tax return");
    expect(within(sheet).getByTestId("points-data-line").textContent).toContain(
      "to your model provider",
    );
    await userEvent.click(within(sheet).getByRole("button", { name: "Start pointing" }));
    await waitFor(() => expect(screen.queryByTestId("points-sheet")).toBeNull());
    const call = gateway().calls.find((c) => c.method === "points.start");
    expect(call?.params).toMatchObject({
      window: "w1",
      goal: "2026 tax return",
      goalSource: "owner",
      entry: "tray",
    });
    const strings = (call?.params as { strings: unknown } | undefined)?.strings;
    expect(PointsCardStrings.properties).toBeTruthy();
    expect(Object.keys(strings as object).sort()).toEqual(
      Object.keys(PointsCardStrings.properties).sort(),
    );
  });

  it("preselects the window the tray found behind Psyche, when it is still listed", async () => {
    setup({ children: <OpenButton window="w1" /> });
    const sheet = await openSheet();
    const safari = await within(sheet).findByRole("radio", { name: /Safari/ });
    await waitFor(() => expect((safari as HTMLInputElement).checked).toBe(true));
  });

  it("shows a running session with Stop pointing", async () => {
    const { gateway } = setup();
    await waitFor(() => expect(gateway()).not.toBeNull());
    const sheet = await openSheet();
    await userEvent.click(await within(sheet).findByRole("radio", { name: /Safari/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Start pointing" }));
    await waitFor(() => expect(screen.queryByTestId("points-sheet")).toBeNull());
    const again = await openSheet();
    const row = await within(again).findByTestId("points-session");
    expect(within(row).getByText("Pointing in Safari")).toBeTruthy();
    await userEvent.click(within(row).getByRole("button", { name: "Stop pointing" }));
    await waitFor(() => expect(within(again).queryByTestId("points-session")).toBeNull());
    expect(gateway().calls.some((c) => c.method === "points.stop")).toBe(true);
  });
});

describe("the Chat offer card", () => {
  const offer = { type: "points_offer" as const, goal: "Fill my 2026 tax return" };

  it("opens the sheet with the goal filled in, and starts nothing by itself", async () => {
    const { gateway } = setup({ children: <PointsOfferCard block={offer} threadId="thr_1" /> });
    const card = await screen.findByTestId("points-offer");
    expect(within(card).getByTestId("points-offer-goal").textContent).toBe(offer.goal);
    const button = await within(card).findByRole("button", { name: "Point me through it" });
    await userEvent.click(button);
    const sheet = await screen.findByTestId("points-sheet");
    expect((within(sheet).getByRole("textbox") as HTMLTextAreaElement).value).toBe(offer.goal);
    expect(gateway().calls.some((c) => c.method === "points.start")).toBe(false);

    await userEvent.click(await within(sheet).findByRole("radio", { name: /Safari/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Start pointing" }));
    await waitFor(() =>
      expect(gateway().calls.find((c) => c.method === "points.start")?.params).toMatchObject({
        goal: offer.goal,
        // The agent's text, passed on unedited, is not the owner's words.
        goalSource: "offer",
        entry: "chat",
        threadId: "thr_1",
      }),
    );
  });

  it("marks an edited goal as the owner's own", async () => {
    const { gateway } = setup({ children: <PointsOfferCard block={offer} /> });
    await userEvent.click(await screen.findByRole("button", { name: "Point me through it" }));
    const sheet = await screen.findByTestId("points-sheet");
    await userEvent.type(within(sheet).getByRole("textbox"), " for Maria");
    await userEvent.click(await within(sheet).findByRole("radio", { name: /Safari/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Start pointing" }));
    await waitFor(() =>
      expect(gateway().calls.find((c) => c.method === "points.start")?.params).toMatchObject({
        goal: `${offer.goal} for Maria`,
        goalSource: "owner",
      }),
    );
  });

  it("says where to start it, with no button, where Points isn't available", async () => {
    setup({ remoteHost: "Studio Mac", children: <PointsOfferCard block={offer} /> });
    const card = await screen.findByTestId("points-offer");
    expect(within(card).queryByRole("button")).toBeNull();
    expect(
      within(card).getByText(/Start Psyche points on the computer where Psyche runs/),
    ).toBeTruthy();
  });
});

function PaletteHost(): ReactElement {
  const [open, setOpen] = useState(true);
  return <CommandPalette open={open} onOpenChange={setOpen} onNavigate={vi.fn()} />;
}

describe("the ⌘K action", () => {
  it("lists Point me through a form and opens the sheet", async () => {
    setup({ children: <PaletteHost /> });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    await userEvent.type(within(palette).getByRole("combobox"), "point me through");
    const option = await within(palette).findByRole("option", { name: /Point me through a form/ });
    await userEvent.click(option);
    expect(await screen.findByTestId("points-sheet")).toBeTruthy();
  });

  it("is not listed in a remote window", async () => {
    setup({ remoteHost: "Studio Mac", children: <PaletteHost /> });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    await userEvent.type(within(palette).getByRole("combobox"), "point me through");
    await waitFor(() =>
      expect(within(palette).queryAllByRole("option").length).toBeGreaterThan(-1),
    );
    expect(within(palette).queryByRole("option", { name: /Point me through a form/ })).toBeNull();
  });
});

describe("Settings → Computer use → Psyche points", () => {
  it("toggles the switch and shows the data line", async () => {
    const onChange = vi.fn();
    render(
      <StoryWorld>
        <PointsSettingsGroup enabled={false} onChange={onChange} />
      </StoryWorld>,
    );
    expect(screen.getByRole("heading", { name: "Psyche points" })).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: /Point me through forms/ }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByTestId("points-data-line").textContent).toContain("to your model provider");
  });

  it("says the data stays on this computer with a local model", () => {
    render(
      <StoryWorld>
        <PointsSettingsGroup enabled onChange={vi.fn()} local />
      </StoryWorld>,
    );
    expect(screen.getByTestId("points-data-line").textContent).toBe("This stays on this computer.");
  });
});

describe("the helper's card strings", () => {
  const keys = Object.keys(
    PointsCardStrings.properties,
  ) as (keyof typeof PointsCardStrings.properties)[];

  it("covers every key the Gateway requires", () => {
    expect(Object.keys(pointsCardStrings()).sort()).toEqual([...keys].sort());
    for (const k of keys) expect(en[`points.card.${k}` as keyof typeof en]).toBeTruthy();
  });

  it("keeps the helper's placeholders and stays within 80 characters in every language", () => {
    const slots: Record<string, string[]> = {
      selfFill: ["{label}"],
      scrollTo: ["{label}"],
      menuBarTitle: ["{app}"],
      stepFormat: ["{n}", "{total}"],
    };
    for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
      for (const k of keys) {
        const id = `points.card.${k}` as keyof typeof en;
        const text = (catalogue as Record<string, string | undefined>)[id] ?? en[id];
        expect(text, `${locale} ${id}`).toBeTruthy();
        expect(text.length, `${locale} ${id} length`).toBeLessThanOrEqual(80);
        for (const slot of slots[k] ?? []) expect(text, `${locale} ${id}`).toContain(slot);
      }
    }
  });

  it("sends the placeholders through unfilled", () => {
    const s = pointsCardStrings();
    expect(s.selfFill).toBe("You fill this yourself: {label}");
    expect(s.stepFormat).toBe("{n}/{total}");
    expect(s.menuBarTitle).toBe("◉ Pointing: {app}");
  });
});
