import { type Connector, PsycheError } from "@psyche/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { appleConnectorsUnavailable } from "../src/data/host-os.ts";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { errorSummary } from "../src/i18n/errors.ts";
import { ComputerUseSection } from "../src/screens/settings/ComputerUseSection.tsx";
import { ConnectorsPanel } from "../src/screens/settings/ConnectorsSection.tsx";
import type { McpState } from "../src/screens/settings/use-mcp.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/**
 * B3 (linux-helper-only design §7.4, §8.4): a Client of a headless Linux Host, and the server's
 * own Settings, say what runs there: computer use on the Host's private screen, Apple connectors
 * only on a Mac host, and a payment that needs a passkey.
 */

afterEach(cleanup);

/** The mock Gateway answers `gateway.info` with this Host OS. */
const hostIs =
  (hostOs: "macos" | "linux" | undefined) =>
  (gw: MockGateway): void => {
    const handlers = (gw as unknown as { handlers: Record<string, (p: unknown) => unknown> })
      .handlers;
    const base = handlers["gateway.info"];
    handlers["gateway.info"] = (p) => ({
      ...(base?.(p) as object),
      ...(hostOs === undefined ? {} : { hostOs }),
    });
  };

describe("computer use from a Client of a Linux Host", () => {
  it("says it runs on the Host's private screen and shows no controls", async () => {
    render(
      <StoryWorld onGateway={hostIs("linux")}>
        <UiSlotsProvider value={{ remoteHost: "lab-box" }}>
          <ComputerUseSection />
        </UiSlotsProvider>
      </StoryWorld>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("computer-use-remote").textContent).toBe(
        "Computer use runs on lab-box's private screen. Watch it and take over from the watch pane.",
      ),
    );
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it.each([["macos" as const], [undefined]])(
    "keeps the R1 wording for a %s Host",
    async (hostOs) => {
      render(
        <StoryWorld onGateway={hostIs(hostOs)}>
          <UiSlotsProvider value={{ remoteHost: "studio-mac" }}>
            <ComputerUseSection />
          </UiSlotsProvider>
        </StoryWorld>,
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.getByTestId("computer-use-remote").textContent).toBe(
        "Computer use works at studio-mac. Ask from there, or use the browser.",
      );
    },
  );
});

describe("Apple connectors on a Host that isn't a Mac", () => {
  it.each([
    ["linux", true],
    ["windows", true],
    ["macos", false],
    [undefined, false],
  ] as const)("appleConnectorsUnavailable(%s) -> %s", (os, want) => {
    expect(appleConnectorsUnavailable(os)).toBe(want);
  });

  const noop = () => {};
  const mcp: McpState = {
    servers: [],
    launcher: "srt",
    loading: false,
    error: null,
    reload: noop,
    checking: false,
    actionError: null,
    actionFailure: null,
    secretFailure: null,
    notice: null,
    review: null,
    check: noop,
    update: noop,
    updated: 0,
    remove: noop,
    setEnabled: noop,
  };
  const notes = (world: ReturnType<typeof createFixtureWorld>): Connector[] => {
    const first = world.connectors[0];
    if (first === undefined) throw new Error("no fixture connector");
    return [
      ...world.connectors,
      { ...first, id: "conn_notes", type: "apple:notes", label: "Notes", account: null },
    ] as Connector[];
  };
  const page = (hostOs: "linux" | "macos", remoteHost?: string) => {
    const world = createFixtureWorld();
    render(
      <StoryWorld onGateway={hostIs(hostOs)}>
        <UiSlotsProvider value={remoteHost === undefined ? {} : { remoteHost }}>
          <ConnectorsPanel
            persona="Wren"
            now={Date.parse(FIXTURE_NOW)}
            connectors={notes(world)}
            mcp={mcp}
            onConnect={noop}
            onReconnect={noop}
            onDisconnect={noop}
            onRemove={noop}
            policy={{ values: {}, onChange: noop }}
            onOpenSection={noop}
          />
        </UiSlotsProvider>
      </StoryWorld>,
    );
  };

  it("marks them Only on a Mac host, on the server's own Settings and on a Client", async () => {
    page("linux");
    await waitFor(() => expect(screen.getByText(/Only on a Mac host/)).toBeTruthy());
    cleanup();
    page("linux", "lab-box");
    await waitFor(() => expect(screen.getByText(/Only on a Mac host/)).toBeTruthy());
  });

  it("keeps On <host> for a Mac Host's Client", async () => {
    page("macos", "studio-mac");
    await waitFor(() => expect(screen.getAllByText(/On studio-mac/).length).toBeGreaterThan(1));
    expect(screen.queryByText(/Only on a Mac host/)).toBeNull();
  });
});

describe("a payment with no passkey on a headless Host", () => {
  it("tells the owner to set up a passkey", () => {
    const err = new PsycheError("presence_required", "Set up a passkey…", {
      details: { reason: "passkey_required" },
    });
    expect(errorSummary(err)).toBe("Set up a passkey to approve payments on this Psyche.");
  });
});
