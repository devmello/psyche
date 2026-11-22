import type { ApprovalRequest, MachineInfo, RunStep } from "@psyche/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalMachineLine } from "../src/blocks/machine-line.ts";
import { stepLabel } from "../src/chat/steps/model.ts";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { ComputerWatch } from "../src/screens/computer-watch/ComputerWatch.tsx";
import { fakeClient } from "../src/screens/computer-watch/fixtures.ts";
import { ComputerUsePanel } from "../src/screens/settings/ComputerUseSection.tsx";
import { MACHINE_APPS_KEY } from "../src/screens/settings/MachinePicker.tsx";
import {
  AddMachineSheet,
  installCommand,
  MachinesGroup,
  MachinesPanel,
  machineWarnings,
  newestHelperVersion,
  pairCommand,
  versionBefore,
} from "../src/screens/settings/MachinesGroup.tsx";
import {
  DEDICATED_BOX,
  FULL_SHELL_BOX,
  IDENTITIES,
  LAB_BOX,
  MACHINES_NOW,
  OFFLINE_BOX,
  OUTDATED_BOX,
  SUDO_BOX,
  USER_LIMITS_BOX,
} from "../src/screens/settings/machine-fixtures.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const panel = (machines: MachineInfo[], props: Partial<Parameters<typeof MachinesPanel>[0]> = {}) =>
  render(
    <StoryWorld>
      <MachinesPanel machines={machines} identities={IDENTITIES} now={MACHINES_NOW} {...props} />
    </StoryWorld>,
  );

describe("versions", () => {
  it.each([
    ["0.8.4", "0.9.2", true],
    ["0.9.2", "0.9.2", false],
    ["0.10.0", "0.9.2", false],
    ["0.9", "0.9.1", true],
    ["v1.0.0", "1.0.1", true],
    ["nightly", "0.9.2", false],
  ])("%s is older than %s: %s", (a, b, older) => {
    expect(versionBefore(a, b)).toBe(older);
  });

  it("the newest version among the computers is what older ones are behind", () => {
    expect(newestHelperVersion([OUTDATED_BOX, LAB_BOX])).toBe("0.9.2");
    expect(newestHelperVersion([{ ...LAB_BOX, helperVersion: null }])).toBeNull();
    expect(newestHelperVersion([])).toBeNull();
  });
});

describe("the warnings a row shows (design 6.5)", () => {
  it.each([
    ["a healthy computer", LAB_BOX, ["userLimits"]],
    ["the contained shell is off", FULL_SHELL_BOX, ["fullShell", "userLimits"]],
    ["limits the account can change", USER_LIMITS_BOX, ["userLimits"]],
    ["passwordless sudo", SUDO_BOX, ["userLimits", "sudo"]],
    ["a dedicated account", DEDICATED_BOX, ["userLimits"]],
    [
      "commands off: no shell warning even though nothing is contained",
      { ...LAB_BOX, exec: { enabled: false, contained: false } },
      ["userLimits"],
    ],
    [
      "all three",
      {
        ...LAB_BOX,
        exec: { enabled: true, contained: false },
        policyOwner: "user" as const,
        passwordlessSudo: true,
      },
      ["fullShell", "userLimits", "sudo"],
    ],
  ])("%s", (_name, machine, expected) => {
    expect(machineWarnings(machine)).toEqual(expected);
  });
});

describe("the commands", () => {
  it("picks the account with a flag and quotes the link", () => {
    expect(installCommand("own")).toBe("sh install.sh");
    expect(installCommand("dedicated")).toBe("sh install.sh --dedicated-user");
    // The link is read from stdin: the token never appears in the command.
    expect(pairCommand()).toBe("psyche-helper pair -");
  });
});

describe("Computers Psyche can use", () => {
  it("starts with the empty state and an Add button", async () => {
    const onAdd = vi.fn();
    panel([], { onAdd });
    expect(screen.getByText(/Give Psyche a Linux computer to work on/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add a Linux computer" }));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("shows an online computer on the owner's account with its limits and only the user-owned warning", () => {
    panel([LAB_BOX]);
    const row = screen.getByTestId("machine-row");
    expect(within(row).getByText("lab-box")).toBeTruthy();
    expect(within(row).getByText("Online")).toBeTruthy();
    expect(within(row).getByText("Private screen")).toBeTruthy();
    expect(within(row).getByText(/Runs as your own account on lab-box/)).toBeTruthy();
    expect(within(row).getByText(/Commands run in a contained shell/)).toBeTruthy();
    expect(within(row).getByText(/1 folder granted/)).toBeTruthy();
    expect(within(row).getByText(/Helper 0\.9\.2/)).toBeTruthy();
    const warnings = within(row).getByRole("list", { name: /Warnings/ });
    expect(within(warnings).getAllByRole("listitem")).toHaveLength(1);
    expect(within(warnings).getByText(/Limits are user-owned/)).toBeTruthy();
    expect(within(row).queryByTestId("machine-update")).toBeNull();
  });

  it("offers the separate account on an own-account row, with the installer flag", () => {
    panel([LAB_BOX]);
    expect(screen.getByText("Use a separate account instead…")).toBeTruthy();
    expect(screen.getByText("sh install.sh --dedicated-user")).toBeTruthy();
  });

  it("a dedicated account says Psyche sees only that account", () => {
    panel([DEDICATED_BOX]);
    expect(screen.getByText(/Runs as a separate account on build-server/)).toBeTruthy();
    expect(screen.queryByText("Use a separate account instead…")).toBeNull();
    expect(screen.getByText(/No folders granted/)).toBeTruthy();
  });

  it("an offline computer says so, and Watch is off", () => {
    panel([OFFLINE_BOX], { onWatch: vi.fn() });
    const row = screen.getByTestId("machine-row");
    expect(within(row).getByText("Offline")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Watch attic-pc" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("an online computer can be watched", async () => {
    const onWatch = vi.fn();
    panel([LAB_BOX], { onWatch });
    await userEvent.click(screen.getByRole("button", { name: "Watch lab-box" }));
    expect(onWatch).toHaveBeenCalledWith(LAB_BOX);
  });

  it("shows how to update a helper that is behind, and only then", () => {
    panel([OUTDATED_BOX, LAB_BOX], { latestHelperVersion: "0.9.2" });
    const rows = screen.getAllByTestId("machine-row");
    expect(within(rows[0] as HTMLElement).getByTestId("machine-update").textContent).toContain(
      "Update the helper on old-laptop",
    );
    expect(within(rows[0] as HTMLElement).getByText("psyche-helper update")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByTestId("machine-update")).toBeNull();
  });

  it.each([
    ["full shell", FULL_SHELL_BOX, /Full account shell/],
    ["user-owned limits", USER_LIMITS_BOX, /Limits are user-owned/],
    ["passwordless sudo", SUDO_BOX, /passwordless sudo/],
  ])("warns about %s", (_n, machine, text) => {
    panel([machine]);
    const list = screen.getByRole("list", { name: `Warnings for ${machine.name}` });
    expect(within(list).getByText(text)).toBeTruthy();
  });

  it("renames inline and puts focus back on Rename", async () => {
    const onRename = vi.fn(() => Promise.resolve());
    panel([LAB_BOX], { onRename });
    await userEvent.click(screen.getByRole("button", { name: "Rename lab-box" }));
    const input = screen.getByLabelText("New name for lab-box");
    await userEvent.clear(input);
    await userEvent.type(input, "attic");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRename).toHaveBeenCalledWith(LAB_BOX, "attic");
    await waitFor(() => expect(screen.queryByLabelText("New name for lab-box")).toBeNull());
  });

  it("keeps the editor open and explains a name that is taken", async () => {
    const onRename = vi.fn(() =>
      Promise.reject(Object.assign(new Error("x"), { code: "conflict" })),
    );
    panel([LAB_BOX], { onRename });
    await userEvent.click(screen.getByRole("button", { name: "Rename lab-box" }));
    await userEvent.type(screen.getByLabelText("New name for lab-box"), "2");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already has that name/);
    expect(screen.getByLabelText("New name for lab-box")).toBeTruthy();
  });

  it("removes only after the confirm dialog", async () => {
    const onRemove = vi.fn();
    panel([LAB_BOX], { onRemove });
    await userEvent.click(screen.getByRole("button", { name: /More for lab-box/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    expect(onRemove).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledWith(LAB_BOX);
  });
});

function connected(ui: React.ReactElement, edit?: (g: MockGateway) => void) {
  let gateway!: MockGateway;
  render(
    <StoryWorld
      onGateway={(g) => {
        gateway = g;
        edit?.(g);
      }}
    >
      {ui}
    </StoryWorld>,
  );
  return () => gateway;
}

describe("the connected group", () => {
  it("lists what machines.list returns and renames through machines.rename", async () => {
    const gw = connected(<MachinesGroup now={MACHINES_NOW} />, (g) => {
      g.pairMachine(LAB_BOX);
      g.pairMachine(DEDICATED_BOX);
    });
    expect(await screen.findByText("build-server")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Rename lab-box" }));
    const input = screen.getByLabelText("New name for lab-box");
    await userEvent.clear(input);
    await userEvent.type(input, "Build-Server");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    // The Gateway matches names case-insensitively: the mock refuses, and the row says why.
    expect((await screen.findByRole("alert")).textContent).toMatch(/already has that name/);
    await userEvent.clear(input);
    await userEvent.type(input, "attic");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("attic")).toBeTruthy();
    expect(gw().calls.filter((c) => c.method === "machines.rename")).toHaveLength(2);
  });

  it("Watch opens the watch pane on that computer", async () => {
    const gw = connected(<MachinesGroup now={MACHINES_NOW} />, (g) => g.pairMachine(LAB_BOX));
    await userEvent.click(await screen.findByRole("button", { name: "Watch lab-box" }));
    await waitFor(() =>
      expect(gw().calls.find((c) => c.method === "view.open")?.params).toEqual({
        pane: "computer-watch",
        target: "mch_lab",
      }),
    );
  });
});

describe("the add sheet", () => {
  it("asks for the account, then shows both commands and turns green when the computer pairs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const gw = connected(<AddMachineSheet open onOpenChange={() => {}} now={STORY_NOW + 1000} />);
      const sheet = await screen.findByTestId("add-machine");
      expect(within(sheet).getByText("Your account (recommended)")).toBeTruthy();
      await userEvent.click(
        within(sheet).getByRole("radio", { name: /A separate psyche account/ }),
      );
      await userEvent.click(within(sheet).getByRole("button", { name: "Show the commands" }));

      const commands = await within(sheet).findByTestId("machine-commands");
      const boxes = within(commands).getAllByRole("textbox") as HTMLTextAreaElement[];
      expect(boxes[0]?.value).toBe("sh install.sh --dedicated-user");
      expect(boxes[1]?.value).toBe("psyche-helper pair -");
      expect(boxes[2]?.value).toMatch(/^psyche-machine:v1:[A-Za-z0-9_-]+$/);
      expect(within(sheet).getByText(/github\.com\/devmello\/psyche\/releases/)).toBeTruthy();
      expect(boxes[1]?.value).not.toContain("psyche-machine");
      expect(gw().calls.find((c) => c.method === "devices.setupToken.create")?.params).toEqual({
        purpose: "machine",
      });
      expect(within(sheet).getByText("Waiting for the computer to pair…")).toBeTruthy();
      expect(within(sheet).queryByTestId("machine-paired")).toBeNull();

      gw().pairMachine(LAB_BOX);
      await vi.advanceTimersByTimeAsync(3_500);
      expect((await within(sheet).findByTestId("machine-paired")).textContent).toContain("lab-box");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the add sheet and a different machine", () => {
  it("does not turn green for a computer that paired some other way", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const gw = connected(<AddMachineSheet open onOpenChange={() => {}} now={STORY_NOW + 1000} />);
      const sheet = await screen.findByTestId("add-machine");
      await userEvent.click(within(sheet).getByRole("button", { name: "Show the commands" }));
      await within(sheet).findByTestId("machine-commands");
      // Another computer pairs at the same moment through a pairing card, not this token.
      gw().world.machines = [LAB_BOX];
      await vi.advanceTimersByTimeAsync(3_500);
      expect(within(sheet).queryByTestId("machine-paired")).toBeNull();
      expect(within(sheet).getByText("Waiting for the computer to pair…")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Computer use with computers paired", () => {
  const values = {
    "computerUse.enabled": true,
    "computerUse.apps": [{ id: "com.apple.Notes", name: "Notes", tier: "interact" }],
    [MACHINE_APPS_KEY]: {
      mch_lab: [{ id: "firefox", name: "Firefox", tier: "read" }],
    },
  };

  const renderPanel = (machines: MachineInfo[], onChange = vi.fn()) => {
    render(
      <StoryWorld>
        <ComputerUsePanel
          values={values}
          onChange={onChange}
          persona="Wren"
          tcc={{}}
          machines={machines}
        />
      </StoryWorld>,
    );
    return onChange;
  };

  it("has no picker without a paired computer", () => {
    renderPanel([]);
    expect(screen.queryByLabelText("Show app access for")).toBeNull();
    expect(screen.getByText("Notes")).toBeTruthy();
  });

  it("shows the picked computer's apps in place of the Host's", async () => {
    const onChange = renderPanel([LAB_BOX, OFFLINE_BOX]);
    expect(screen.getByText("Notes")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Show app access for"), "mch_lab");
    expect(screen.getByText("Apps on lab-box")).toBeTruthy();
    expect(screen.getByText("Firefox")).toBeTruthy();
    expect(screen.queryByText("Notes")).toBeNull();

    await userEvent.click(screen.getByRole("radio", { name: "Firefox: Read and interact" }));
    expect(onChange).toHaveBeenCalledWith(MACHINE_APPS_KEY, {
      mch_lab: [{ id: "firefox", name: "Firefox", tier: "interact" }],
    });
  });

  it("says when the picked computer is offline", async () => {
    renderPanel([LAB_BOX, OFFLINE_BOX]);
    await userEvent.selectOptions(screen.getByLabelText("Show app access for"), "mch_off");
    expect(screen.getByText(/attic-pc is offline/)).toBeTruthy();
    expect(screen.getByText(/hasn't seen any apps on attic-pc/)).toBeTruthy();
  });

  it("sets the default computer for background work", async () => {
    const onChange = renderPanel([LAB_BOX]);
    await userEvent.selectOptions(
      screen.getByLabelText("Default computer for background work"),
      "mch_lab",
    );
    expect(onChange).toHaveBeenCalledWith("computerUse.defaultMachine", "mch_lab");
  });
});

describe("the machine line on cards and trace steps", () => {
  const card = (kind: string, details: Record<string, unknown> = {}) =>
    ({
      kind,
      details,
      machine: { deviceId: "dev_lab", name: "lab-box" },
    }) as unknown as Pick<ApprovalRequest, "kind" | "details"> & {
      machine: { deviceId: string; name: string };
    };

  it.each([
    ["computer_action", { surface: "virtual_screen" }, "On “lab-box” · Linux · private screen"],
    ["computer_action", {}, "On “lab-box” · Linux · private screen"],
    ["computer_action", { surface: "direct" }, "On “lab-box” · Linux · its desktop"],
    ["exec_host", {}, "On “lab-box” · Linux · command"],
    ["folder_access", {}, "On “lab-box” · Linux · files"],
    ["connector_action", { tool: "machine_files" }, "On “lab-box” · Linux · files"],
    ["permission_request", { tool: "machine_files" }, "On “lab-box” · Linux · files"],
  ])("%s %j reads %s", (kind, details, line) => {
    expect(approvalMachineLine(card(kind, details))?.replace(/[\u2068\u2069]/g, "")).toBe(line);
  });

  it("has no line for the Host", () => {
    expect(approvalMachineLine({ kind: "exec_host", details: {} })).toBeNull();
  });

  it("a name that imitates the rest of the line stays a quoted, isolated name", () => {
    const line = approvalMachineLine({
      kind: "exec_host",
      details: {},
      machine: { deviceId: "d", name: "lab-box · Linux · private screen" },
    }) as string;
    expect(line).toBe("On “\u2068lab-box · Linux · private screen\u2069” · Linux · command");
  });

  it("cleans a name that carries a hidden character", () => {
    const line = approvalMachineLine({
      kind: "exec_host",
      details: {},
      machine: { deviceId: "d", name: "lab‮box" },
    });
    expect(line).not.toContain("‮");
  });

  const step = (over: Partial<RunStep>): RunStep =>
    ({
      id: "stp_1",
      runId: "run_1",
      seq: 1,
      kind: "tool",
      status: "ok",
      label: "Opening Firefox",
      doneLabel: "Opened Firefox",
      startedAt: "2026-11-19T12:00:00Z",
      endedAt: "2026-11-19T12:00:02Z",
      attempt: 1,
      ...over,
    }) as RunStep;

  it("names the computer on a step that ran there, and only then", () => {
    expect(stepLabel(step({}))).toBe("Opened Firefox");
    expect(stepLabel(step({ machine: { deviceId: "dev_lab", name: "lab-box" } }))).toBe(
      "Opened Firefox on lab-box",
    );
    expect(
      stepLabel(step({ status: "running", machine: { deviceId: "dev_lab", name: "lab-box" } })),
    ).toBe("Opening Firefox on lab-box");
  });
});

describe("the watch pane", () => {
  it("reads 'lab-box · private screen' for a computer and 'Virtual screen' for the Host", async () => {
    const { rerender } = render(
      <ComputerWatch client={fakeClient()} visible machine={{ name: "lab-box" }} />,
    );
    expect(screen.getByRole("region", { name: "lab-box · private screen" })).toBeTruthy();
    rerender(<ComputerWatch client={fakeClient()} visible />);
    expect(screen.getByRole("region", { name: "Virtual screen" })).toBeTruthy();
  });

  it("names the computer when it cannot be reached", async () => {
    const client = fakeClient();
    client.status = () => Promise.reject(new Error("offline"));
    render(<ComputerWatch client={client} visible machine={{ name: "lab-box" }} />);
    expect(await screen.findByText("Can't reach lab-box. Trying again…")).toBeTruthy();
  });
});
