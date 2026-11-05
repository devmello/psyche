import type { NodeInfo } from "@psyche/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockGateway, RecordedCall } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import { en } from "../src/i18n/messages/index.ts";
import { windows } from "../src/i18n/messages/variants/windows.ts";
import { setUiPlatform } from "../src/lib/platform.ts";
import {
  formatSize,
  SandboxPcControls,
  SandboxPcOnboarding,
  SandboxPcSetup,
} from "../src/screens/settings/SandboxPcSection.tsx";
import { VmSection } from "../src/screens/settings/VmSection.tsx";
import type { SandboxPcSlot, SandboxPcState } from "../src/slots.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(() => setUiPlatform(undefined));

const NOW = Date.parse(FIXTURE_NOW);

const OFF: SandboxPcState = {
  phase: "off",
  serviceInstalled: false,
  imageVersion: null,
  downloadBytes: 612_000_000,
  diskBytes: 2_300_000_000,
};

describe("the sandbox PC card", () => {
  it("explains the one administrator prompt and the download size before turning on", async () => {
    setUiPlatform("windows");
    const onTurnOn = vi.fn();
    render(<SandboxPcSetup persona="Moth" state={OFF} onTurnOn={onTurnOn} onCancel={() => {}} />);
    expect(screen.getByRole("heading", { name: "Turn on the sandbox PC" })).toBeTruthy();
    expect(screen.getByText(/administrator approval once/)).toBeTruthy();
    expect(screen.getByText(/612 MB, 2.3 GB on disk/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Turn on the sandbox PC" }));
    expect(onTurnOn).toHaveBeenCalledOnce();
  });

  it("shows the image download as progress with a cancel", async () => {
    const onCancel = vi.fn();
    render(
      <SandboxPcSetup
        persona="Moth"
        state={{
          ...OFF,
          phase: "downloading",
          serviceInstalled: true,
          download: { receivedBytes: 306_000_000, totalBytes: 612_000_000 },
        }}
        onTurnOn={() => {}}
        onCancel={onCancel}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "PC image download" });
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByText("Downloading the PC image: 306 MB of 612 MB")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on the sandbox PC" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancel download" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("says what is happening during the prompt and after, and what failed", () => {
    const view = render(
      <SandboxPcSetup
        persona="Moth"
        state={{ ...OFF, phase: "installing" }}
        onTurnOn={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("Waiting for the administrator prompt…")).toBeTruthy();
    view.rerender(
      <SandboxPcSetup
        persona="Moth"
        state={{ ...OFF, phase: "failed", message: "The administrator prompt was dismissed" }}
        onTurnOn={() => {}}
        onCancel={() => {}}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("The administrator prompt was dismissed");
    // Failing leaves the button, so it can be tried again.
    expect(screen.getByRole("button", { name: "Turn on the sandbox PC" })).toBeTruthy();
    view.rerender(
      <SandboxPcSetup
        persona="Moth"
        state={{ ...OFF, phase: "ready", serviceInstalled: true, imageVersion: "2026.11.1" }}
        onTurnOn={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("Set up")).toBeTruthy();
    expect(screen.getByText("The sandbox PC is set up. Version 2026.11.1.")).toBeTruthy();
  });

  it("formats sizes in the reader's numbers", () => {
    expect(formatSize(612_000_000)).toBe("612 MB");
    expect(formatSize(2_340_000_000)).toBe("2.3 GB");
    expect(formatSize(10)).toBe("1 MB");
  });
});

describe("the sandbox PC controls", () => {
  const base = {
    helperReady: true,
    setUp: true,
    snapshots: [],
    baseSnapshot: null,
    busy: false,
    error: null,
    now: NOW,
    onCreate: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onResume: vi.fn(),
    onSnapshot: vi.fn(),
    onRestore: vi.fn(),
    onReset: vi.fn(),
    onDeleteSnapshot: vi.fn(),
  };
  const guest = (phase: string) =>
    ({
      name: "sandbox",
      phase,
      provisioned: true,
      cpus: 2,
      memoryGB: 4,
      diskGB: 40,
      guestOS: "Debian 13",
      username: "psyche",
      shares: [],
      vsock: { hostCid: 2, gatewayNodePort: 7980 },
    }) as never;

  it("creates the guest once it is set up, and not before the helper offers it", async () => {
    const onCreate = vi.fn();
    const view = render(
      <SandboxPcControls {...base} guest={undefined} onCreate={onCreate} helperReady={false} />,
    );
    expect(screen.getByTestId("sandbox-pc-helper-offline")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Create the sandbox PC" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    view.rerender(<SandboxPcControls {...base} guest={undefined} onCreate={onCreate} />);
    await userEvent.click(screen.getByRole("button", { name: "Create the sandbox PC" }));
    expect(onCreate).toHaveBeenCalledOnce();
    view.rerender(<SandboxPcControls {...base} guest={undefined} setUp={false} />);
    expect(
      (screen.getByRole("button", { name: "Create the sandbox PC" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("starts a stopped guest and stops a running one", async () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const view = render(<SandboxPcControls {...base} guest={guest("stopped")} onStart={onStart} />);
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onStart).toHaveBeenCalledOnce();
    view.rerender(<SandboxPcControls {...base} guest={guest("running")} onStop={onStop} />);
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("lists snapshots, saves, restores and resets only while stopped", async () => {
    const snapshot = {
      id: "snap-1",
      label: "Before the install",
      kind: "base",
      createdAt: FIXTURE_NOW,
    } as never;
    const onRestore = vi.fn();
    const onReset = vi.fn();
    const onSnapshot = vi.fn();
    const props = {
      ...base,
      snapshots: [snapshot],
      baseSnapshot: "snap-1",
      onRestore,
      onReset,
      onSnapshot,
    };
    const view = render(<SandboxPcControls {...props} guest={guest("running")} />);
    expect(screen.getByText("Stop the sandbox PC first.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    view.rerender(<SandboxPcControls {...props} guest={guest("stopped")} />);
    const row = screen.getByText(/Before the install/).closest("li") as HTMLElement;
    expect(within(row).getByText("Fresh PC")).toBeTruthy();
    await userEvent.click(within(row).getByRole("button", { name: "Restore" }));
    expect(onRestore).toHaveBeenCalledWith("snap-1");
    await userEvent.click(screen.getByRole("button", { name: "Reset to the fresh PC" }));
    expect(onReset).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Save as the fresh PC" }));
    expect(onSnapshot).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole("button", { name: "Save a snapshot" }));
    expect(onSnapshot).toHaveBeenLastCalledWith(false);
  });
});

/** A slot that records what the card asks of the desktop. */
function fakeSlot(first: SandboxPcState): {
  slot: SandboxPcSlot;
  push: (s: SandboxPcState) => void;
  turnOn: ReturnType<typeof vi.fn>;
} {
  let listener: ((s: SandboxPcState) => void) | undefined;
  const turnOn = vi.fn(async () => ({
    ...first,
    phase: "ready" as const,
    serviceInstalled: true,
    imageVersion: "2026.11.1",
  }));
  return {
    slot: {
      getState: async () => first,
      refresh: async () => first,
      turnOn,
      cancel: async () => {},
      onState: (cb) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
    },
    push: (s) => listener?.(s),
    turnOn,
  };
}

const helperNode = (): NodeInfo =>
  ({
    id: "node_win_helper",
    deviceId: "dev_win",
    kind: "win-helper",
    status: "online",
    capabilities: ["vm.status", "vm.create", "vm.start", "vm.stop"].map((name) => ({
      name,
      sideEffect: "write",
      streaming: false,
    })),
    lastHeartbeatAt: "2026-10-18T10:00:00Z",
  }) as never;

function renderSection(slot: SandboxPcSlot | undefined, withHelper: boolean) {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld
      edit={(w) => {
        if (withHelper) w.nodes = [...w.nodes, helperNode()];
      }}
      onGateway={(g) => {
        gw = g;
      }}
      slots={slot ? { sandboxPc: slot } : {}}
    >
      <VmSection now={NOW} />
    </StoryWorld>,
  );
  return () => gw as unknown as MockGateway;
}

const callsOf = (g: MockGateway, method: string): RecordedCall[] =>
  g.calls.filter((c) => c.method === method);

describe("Settings → Sandbox PC on Windows", () => {
  it("is the real screen now, not 'Available on macOS'", async () => {
    setUiPlatform("windows");
    const { slot } = fakeSlot(OFF);
    renderSection(slot, false);
    expect(await screen.findByRole("heading", { name: "Turn on the sandbox PC" })).toBeTruthy();
    expect(screen.queryByText("Available on macOS")).toBeNull();
    expect(screen.queryByTestId("vm-mac-only")).toBeNull();
    // Windows wording for the settings below it.
    expect(
      await screen.findByRole("switch", { name: "Use the sandbox PC for tasks" }),
    ).toBeTruthy();
  });

  it("turns on through the desktop slot and then offers to create the guest", async () => {
    setUiPlatform("windows");
    const { slot, turnOn } = fakeSlot(OFF);
    const gateway = renderSection(slot, true);
    await userEvent.click(await screen.findByRole("button", { name: "Turn on the sandbox PC" }));
    expect(turnOn).toHaveBeenCalledOnce();
    const create = await screen.findByRole("button", { name: "Create the sandbox PC" });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(create);
    await waitFor(() =>
      expect(
        callsOf(gateway(), "nodes.invoke").map(
          (c) => (c.params as { capability: string }).capability,
        ),
      ).toContain("vm.create"),
    );
    const call = callsOf(gateway(), "nodes.invoke")[0] as RecordedCall;
    expect(call.params).toMatchObject({
      nodeId: "node_win_helper",
      capability: "vm.create",
      params: { download: true },
    });
  });

  it("follows the desktop's progress events", async () => {
    setUiPlatform("windows");
    const { slot, push } = fakeSlot(OFF);
    renderSection(slot, false);
    await screen.findByRole("button", { name: "Turn on the sandbox PC" });
    act(() =>
      push({
        ...OFF,
        phase: "downloading",
        serviceInstalled: true,
        download: { receivedBytes: 153_000_000, totalBytes: 612_000_000 },
      }),
    );
    expect(
      (await screen.findByRole("progressbar", { name: "PC image download" })).getAttribute(
        "aria-valuenow",
      ),
    ).toBe("25");
  });

  it("without the desktop slot (the web) it shows the settings only", async () => {
    setUiPlatform("windows");
    renderSection(undefined, false);
    expect(
      await screen.findByRole("switch", { name: "Use the sandbox PC for tasks" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Turn on the sandbox PC" })).toBeNull();
  });

  it("keeps the Mac screen on macOS", async () => {
    setUiPlatform("macos");
    const { slot } = fakeSlot(OFF);
    renderSection(slot, false);
    expect(await screen.findByRole("switch", { name: "Use a sandbox Mac for tasks" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Turn on the sandbox PC" })).toBeNull();
  });
});

describe("the Windows wording", () => {
  it("only replaces messages that exist, with the same placeholders", () => {
    for (const id of [
      "settings.nav.vm",
      "settings.key.vm.enabled",
      "settings.vm.sandboxMac",
      "settings.vm.description",
    ] as const) {
      expect(Object.hasOwn(windows, id)).toBe(true);
      expect(Object.hasOwn(en, id)).toBe(true);
    }
    expect(windows["settings.vm.description"]).toContain("{persona}");
  });
});

describe("onboarding's Safety step", () => {
  it("offers the sandbox PC only where the desktop can turn it on", async () => {
    setUiPlatform("windows");
    const { slot } = fakeSlot(OFF);
    const view = render(
      <UiSlotsProvider value={{ sandboxPc: slot }}>
        <SandboxPcOnboarding />
      </UiSlotsProvider>,
    );
    expect(await screen.findByRole("button", { name: "Turn on the sandbox PC" })).toBeTruthy();
    expect(screen.getByText(/Optional: a private Linux PC/)).toBeTruthy();
    view.unmount();
    render(
      <UiSlotsProvider value={{}}>
        <SandboxPcOnboarding />
      </UiSlotsProvider>,
    );
    expect(screen.queryByTestId("sandbox-pc-onboarding")).toBeNull();
  });

  it("stays out of the way when the build has no service", async () => {
    const { slot } = fakeSlot({
      phase: "unsupported",
      message: "This build of Psyche has no sandbox PC service",
      serviceInstalled: false,
      imageVersion: null,
    });
    render(
      <UiSlotsProvider value={{ sandboxPc: slot }}>
        <SandboxPcOnboarding />
      </UiSlotsProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId("sandbox-pc-onboarding")).toBeNull());
  });
});
