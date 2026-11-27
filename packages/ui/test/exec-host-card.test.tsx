import type { ApprovalRequest } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { PermissionActionsProvider } from "../src/blocks/permission-actions.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { setUiPlatform } from "../src/lib/platform.ts";
import { FileAccessPanel } from "../src/screens/settings/FileAccessSection.tsx";
import { type UiSlots, UiSlotsProvider } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/**
 * The `exec_host` card (security §5.4) and the `permission_request` card (§3.13): the exact
 * command, cwd, env and program; srt unless the owner types UNSANDBOXED, which leaves Allow once
 * only; without srt, Allow waits for the word and Set up sandbox is offered. A permission card
 * says what is missing and Enables it or sends the owner to fix it, then checks again.
 */

const NOW = Date.parse(FIXTURE_NOW);

function approval(over: Partial<ApprovalRequest>): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  return {
    ...base,
    deviceOnly: true,
    requiresAuthentication: true,
    taint: false,
    ...over,
  } as ApprovalRequest;
}

const execHost = (sandbox: "srt" | "missing", over: Partial<ApprovalRequest> = {}) =>
  approval({
    kind: "exec_host",
    summary: "Run `npm test` on this Mac",
    details: {
      argv: ["npm", "test"],
      cwd: "/Users/me/Projects/app",
      env: ["CI=1"],
      executable: "/opt/homebrew/Cellar/node/24.1.0/bin/npm",
      executableSha256: `sha256:${"a".repeat(64)}`,
      allowedDomains: [],
      sandbox,
      ...(sandbox === "missing" ? { sandboxMissingReason: "srt is not installed" } : {}),
      unsandboxedWord: "UNSANDBOXED",
    },
    scopesOffered: ["once", "always"],
    ...over,
  });

const permission = (need: Record<string, unknown>, requiresAuthentication = true) =>
  approval({
    kind: "permission_request",
    summary: "Permission needed",
    details: { need, reason: "to run your tests" },
    scopesOffered: ["once"],
    requiresAuthentication,
  });

function show(a: ApprovalRequest, slots: UiSlots = {}, onAnswer = vi.fn()) {
  render(
    <UiSlotsProvider value={slots}>
      <ApprovalCard approval={a} canAnswer now={NOW} armDelayMs={0} onAnswer={onAnswer} />
    </UiSlotsProvider>,
  );
  return onAnswer;
}

const allow = () => screen.getByRole("button", { name: "Allow" });

describe("exec_host card", () => {
  it("shows the exact argv, cwd, env, resolved program and that it runs in the sandbox", () => {
    show(execHost("srt", { requiresAuthentication: false }));
    expect(screen.getByText("npm")).toBeTruthy();
    expect(screen.getByText("test")).toBeTruthy();
    expect(screen.getByText("/Users/me/Projects/app")).toBeTruthy();
    expect(screen.getByText("CI=1")).toBeTruthy();
    expect(screen.getByText("/opt/homebrew/Cellar/node/24.1.0/bin/npm")).toBeTruthy();
    expect(screen.getByText(/in the sandbox: it cannot read Psyche's vault/)).toBeTruthy();
    // One control set: Deny, one lasting choice named by what it covers, then Allow.
    expect(screen.getByRole("button", { name: "Always allow this exact command" })).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Deny" })).toHaveLength(1);
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("shows the exec reviewer's one line as a hint when it asked, and nothing without one", () => {
    show(
      execHost("srt", {
        details: { ...execHost("srt").details, reviewerHint: "publishing was not asked for" },
      }),
    );
    expect(screen.getByText("Reviewer's note")).toBeTruthy();
    expect(screen.getByText("publishing was not asked for")).toBeTruthy();
  });

  it("has no reviewer row on an ordinary card", () => {
    show(execHost("srt"));
    expect(screen.queryByText("Reviewer's note")).toBeNull();
  });

  it("has no typing field; the button sends the same once-only confirmation the word did", async () => {
    const onAnswer = show(execHost("srt"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/UNSANDBOXED/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Run once without the sandbox" }));
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith("approve", "once", { unsandboxed: "UNSANDBOXED" }),
    );
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it("the button never turns an ordinary Allow into an unsandboxed one (positive control)", async () => {
    const onAnswer = show(execHost("srt"));
    await userEvent.click(allow());
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("approve", "once", undefined));
  });

  it("an approval without the word sends no unsandboxed flag", async () => {
    const onAnswer = show(execHost("srt"));
    await userEvent.click(allow());
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("approve", "once", undefined));
  });

  it("without srt: says so, offers Set up sandbox, and only the once-only button can run it", async () => {
    const permissionAction = vi.fn();
    const onAnswer = show(execHost("missing"), { permissionAction });
    expect(screen.getByText(/the sandbox is not set up \(srt is not installed\)/)).toBeTruthy();
    expect(allow().hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Set up sandbox" }));
    expect(permissionAction).toHaveBeenCalledWith({ need: "sandbox" }, "open");
    expect(screen.queryByRole("textbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Run once without the sandbox" }));
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith("approve", "once", { unsandboxed: "UNSANDBOXED" }),
    );
  });

  it("a card for another kind of action has no unsandboxed button (positive control above)", () => {
    show(permission({ need: "capability", capability: "exec_host" }));
    expect(screen.queryByRole("button", { name: "Run once without the sandbox" })).toBeNull();
  });
});

describe("exec_host card on Windows (no host sandbox)", () => {
  it("offers no sandbox to set up; Allow waits for the typed word, once only", async () => {
    setUiPlatform("windows");
    try {
      const permissionAction = vi.fn();
      const onAnswer = show(
        execHost("missing", {
          details: {
            argv: ["whoami"],
            cwd: "C:\\Users\\me\\Projects\\app",
            env: [],
            executable: "C:\\Windows\\System32\\whoami.exe",
            executableSha256: `sha256:${"a".repeat(64)}`,
            allowedDomains: [],
            sandbox: "missing",
            sandboxMissingReason: "unsupported_platform",
            hostSandbox: "none",
            unsandboxedWord: "UNSANDBOXED",
          },
        }),
        { permissionAction },
      );
      expect(screen.getByText(/Windows has no sandbox for commands on this PC/)).toBeTruthy();
      expect(screen.getByText(/without a sandbox: Windows has none/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Set up sandbox" })).toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(allow().hasAttribute("disabled")).toBe(true);
      await userEvent.click(screen.getByRole("button", { name: "Run once without the sandbox" }));
      await waitFor(() =>
        expect(onAnswer).toHaveBeenCalledWith("approve", "once", { unsandboxed: "UNSANDBOXED" }),
      );
      expect(permissionAction).not.toHaveBeenCalled();
    } finally {
      setUiPlatform(undefined);
    }
  });
});

describe("Set up sandbox from the exec_host card (#966)", () => {
  const srt = (available: boolean): MockGateway["sandboxSetup"]["srt"] => ({
    available,
    path: available ? "/opt/homebrew/bin/srt" : null,
    source: available ? "detected" : null,
    version: available ? "1.0.0" : null,
    problem: available ? null : "not_found",
  });

  it("opens the sandbox setup dialog; once srt is ready, Allow no longer needs the word", async () => {
    let gw: MockGateway | null = null;
    const onAnswer = vi.fn();
    render(
      <StoryWorld
        onGateway={(g) => {
          gw = g;
          g.sandboxSetup = { ...g.sandboxSetup, ready: false, srt: srt(false) };
        }}
      >
        <PermissionActionsProvider>
          <ApprovalCard
            approval={execHost("missing")}
            canAnswer
            now={NOW}
            armDelayMs={0}
            onAnswer={onAnswer}
          />
        </PermissionActionsProvider>
      </StoryWorld>,
    );
    expect(allow().hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Set up sandbox" }));
    const dialog = await screen.findByRole("dialog", { name: "Set up the sandbox" });
    expect(await within(dialog).findByText("Install srt")).toBeTruthy();
    const g = gw as MockGateway | null;
    if (g === null) throw new Error("gateway not ready");
    g.sandboxSetup = { ...g.sandboxSetup, ready: true, srt: srt(true) };
    await userEvent.click(within(dialog).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(allow().hasAttribute("disabled")).toBe(false));
    expect(screen.getByText(/Runs in the sandbox/)).toBeTruthy();
    await userEvent.click(allow());
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("approve", "once", undefined));
  });
});

describe("permission request card", () => {
  it("turning on a capability: names it, needs Touch ID, and Enable approves once", async () => {
    const onAnswer = show(permission({ need: "capability", capability: "exec_host" }));
    expect(screen.getByText("Turn on Run commands on this Mac")).toBeTruthy();
    expect(screen.getByText("to run your tests")).toBeTruthy();
    expect(screen.getByText(/Each action still asks you/)).toBeTruthy();
    expect(screen.getByText(/Touch ID|passkey/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("approve", "once", undefined));
  });

  it("a connector group set to deny names the connector and group", () => {
    show(permission({ need: "connector_action", connector: "apple.mail", group: "mail.send" }));
    expect(screen.getByText(/Let Apple mail ask you before mail.send/)).toBeTruthy();
  });

  it("macOS access: Open System Settings, then Check again re-reads it before answering", async () => {
    const permissionAction = vi.fn(async () => undefined);
    const need = { need: "macos_access", connector: "apple-1", reason: "permission_missing" };
    const onAnswer = show(permission(need, false), { permissionAction });
    await userEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(permissionAction).toHaveBeenCalledWith(need, "open");
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalled());
    expect(permissionAction).toHaveBeenLastCalledWith(need, "check");
  });

  it("a connector that is not connected opens Connectors", async () => {
    const permissionAction = vi.fn();
    show(permission({ need: "connector", connector: "google" }, false), { permissionAction });
    expect(screen.getByText("Connect google")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open Connectors" }));
    expect(permissionAction).toHaveBeenCalledWith(
      { need: "connector", connector: "google" },
      "open",
    );
  });

  it("Deny grants nothing", async () => {
    const onAnswer = show(permission({ need: "capability", capability: "exec_host" }));
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("deny", undefined, undefined));
  });
});

describe("Settings → File access: Run commands on this Mac", () => {
  it("is off by default and the switch writes exec.execHostEnabled, keeping the policy", async () => {
    const onChange = vi.fn();
    const values = { "permissions.policy": { folders: [{ path: "/p", mode: "rw" }] } };
    render(<FileAccessPanel values={values} onChange={onChange} persona="Psyche" />);
    const sw = screen.getByRole("switch", { name: "Allow commands on this Mac" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith("permissions.policy", {
      folders: [{ path: "/p", mode: "rw" }],
      exec: { execHostEnabled: true },
    });
  });

  it("Run read-only commands without asking: on by default, off writes false, waits for exec_host", async () => {
    const onChange = vi.fn();
    const off = { "permissions.policy": { folders: [] } };
    const { unmount } = render(
      <FileAccessPanel values={off} onChange={onChange} persona="Psyche" />,
    );
    const name = "Run read-only commands without asking";
    expect(screen.getByRole("switch", { name }).getAttribute("aria-checked")).toBe("true");
    const sw = screen.getByRole("switch", { name });
    expect(
      sw.hasAttribute("disabled") ||
        sw.getAttribute("aria-disabled") === "true" ||
        sw.hasAttribute("data-disabled"),
    ).toBe(true);
    unmount();
    const on = { "permissions.policy": { folders: [], exec: { execHostEnabled: true } } };
    render(<FileAccessPanel values={on} onChange={onChange} persona="Psyche" />);
    await userEvent.click(screen.getByRole("switch", { name }));
    // `permissions.policy` is a security setting: the Gateway asks for fresh presence on save.
    expect(onChange).toHaveBeenCalledWith("permissions.policy", {
      folders: [],
      exec: { execHostEnabled: true, readOnlyWithoutAsking: false },
    });
  });
});

describe("a read-only command's card (security §5.4)", () => {
  it("says read, never destructive", () => {
    show(
      execHost("srt", {
        summary: "Run `git status` on this Mac",
        sideEffect: "read",
        details: {
          argv: ["git", "status"],
          cwd: "/Users/me/Projects/app",
          env: [],
          executable: "/usr/bin/git",
          executableSha256: `sha256:${"b".repeat(64)}`,
          allowedDomains: [],
          sandbox: "srt",
          unsandboxedWord: "UNSANDBOXED",
          readOnly: true,
        },
        taint: true,
        scopesOffered: ["once"],
      }),
    );
    expect(document.body.textContent).toContain("git status");
    expect(document.body.textContent).not.toMatch(/destructive/i);
  });
});

describe("one control set, friendly taint, one reason (shared by every approval card)", () => {
  const tainted = {
    taint: true,
    scopesOffered: ["once"],
    taintSources: [{ sourceKind: "web_fetch", origin: "https://www.example.com/page" }],
  } as Partial<ApprovalRequest>;

  it("a tainted run-command card says why in words, offers only Allow once, no raw ids", () => {
    show(execHost("srt", tainted));
    expect(screen.getByTestId("taint-note").textContent).toBe(
      "Earlier in this chat The agent read example.com, so only Allow once is offered.",
    );
    expect(screen.queryByRole("button", { name: /Always/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "More options…" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Deny" })).toHaveLength(1);
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("a permission card shows its reason once, not again beside the requester", () => {
    show(permission({ need: "capability", capability: "exec_host" }));
    expect(screen.getAllByText("to run your tests")).toHaveLength(1);
  });

  it("a generic tool approval keeps the reason line and shows the taint sentence", () => {
    show(
      approval({
        kind: "file_write",
        summary: "Do a thing",
        details: { reason: "because you asked", taintSources: ["web_fetch:https://example.com/"] },
        ...tainted,
      }),
    );
    expect(screen.getAllByText(/because you asked/)).toHaveLength(1);
    expect(screen.queryByText(/web_fetch:/)).toBeNull();
    expect(screen.getByTestId("taint-note")).toBeTruthy();
  });
});
