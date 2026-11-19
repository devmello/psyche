import type { OnePasswordSetupStatus } from "@psyche/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import {
  ONEPASSWORD_GUIDE_URL,
  OnePasswordSetupPanel,
} from "../src/screens/settings/OnePasswordSetup.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings → Credentials → 1Password: one next step per state, shaped like the Gateway's answers. */

afterEach(cleanup);

const account = { url: "my.1password.com", email: "owner@example.com" };
const statuses = {
  not_installed: { state: "not_installed", connected: false, os: "macos" as const },
  not_integrated: {
    state: "not_integrated",
    connected: false,
    os: "macos" as const,
    op: { path: "/opt/homebrew/bin/op" },
  },
  locked: {
    state: "locked",
    connected: false,
    os: "macos" as const,
    op: { path: "/opt/homebrew/bin/op" },
  },
  error: {
    state: "error",
    connected: false,
    os: "macos" as const,
    op: { path: "/opt/homebrew/bin/op" },
  },
  signed_in: {
    state: "signed_in",
    connected: false,
    os: "macos" as const,
    op: { path: "/opt/homebrew/bin/op" },
    account,
  },
  connected: {
    state: "signed_in",
    connected: true,
    os: "macos" as const,
    op: { path: "/opt/homebrew/bin/op" },
    account,
  },
  config: {
    state: "signed_in",
    connected: false,
    os: "macos" as const,
    managedBy: "config",
    op: { path: "/opt/homebrew/bin/op" },
    account,
  },
} satisfies Record<string, OnePasswordSetupStatus>;

function setup(status: OnePasswordSetupStatus, extra: { fail?: (g: MockGateway) => void } = {}) {
  let gw: MockGateway | null = null;
  const openExternal = vi.fn(async (_url: string) => {});
  render(
    <StoryWorld
      slots={{ openExternal }}
      edit={(w) => {
        w.onePassword = { status, vaultCount: 3 };
      }}
      onGateway={(g) => {
        gw = g;
        extra.fail?.(g);
      }}
    >
      <OnePasswordSetupPanel />
    </StoryWorld>,
  );
  return { gw: () => gw as unknown as MockGateway, openExternal };
}

/** Opening the panel runs no `op`; Check asks it. */
async function check(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: "Check" }));
}

const button = (name: string) => screen.queryByRole("button", { name });
const callsOf = (g: MockGateway, method: string) => g.calls.filter((c) => c.method === method);

describe("the step for each state", () => {
  it("not installed: the install command, the guide and Check again", async () => {
    setup(statuses.not_installed);
    expect((await screen.findByTestId("onepassword-step")).textContent).toContain(
      "cannot find the 1Password command-line tool",
    );
    expect(screen.getByText("brew install --cask 1password-cli")).toBeTruthy();
    expect(button("Open the guide")).toBeTruthy();
    expect(button("Check again")).toBeTruthy();
    expect(button("Test connection")).toBeNull();
    expect(button("Use 1Password in Psyche")).toBeNull();
  });

  it("found: opening the panel runs no op; Check is the first step", async () => {
    const s = setup(statuses.signed_in);
    expect((await screen.findByTestId("onepassword-step")).textContent).toContain(
      "found the 1Password command-line tool",
    );
    expect(button("Check")).toBeTruthy();
    expect(button("Use 1Password in Psyche")).toBeNull();
    expect(button("Test connection")).toBeNull();
    // The panel loaded without asking op anything.
    const status = callsOf(s.gw(), "vault.onePassword.status");
    expect(status.length).toBeGreaterThan(0);
    expect(status.every((c) => (c.params as { probe?: boolean }).probe !== true)).toBe(true);
  });

  it("a changed or unsigned op: says so and offers Check again", async () => {
    setup({ state: "error", connected: true, os: "macos", problem: "op_changed" });
    expect((await screen.findByTestId("onepassword-step")).textContent).toContain(
      "changed since you connected",
    );
    // Check again (a probe) and Disconnect are both offered.
    expect(button("Check again")).toBeTruthy();
    expect(button("Disconnect")).toBeTruthy();
    cleanup();
    setup({ state: "error", connected: false, os: "macos", problem: "op_unsigned" });
    expect((await screen.findByTestId("onepassword-step")).textContent).toContain(
      "not signed by 1Password",
    );
    expect(button("Check again")).toBeTruthy();
  });

  it("off macOS the install command is not shown", async () => {
    setup({ state: "not_installed", connected: false, os: "other" });
    await screen.findByTestId("onepassword-step");
    expect(screen.queryByText("brew install --cask 1password-cli")).toBeNull();
    expect(button("Open the guide")).toBeTruthy();
  });

  it("an unsafe folder is named, not reported as not installed", async () => {
    setup({ state: "error", connected: false, os: "macos", problem: "op_unsafe_folder" });
    const step = await screen.findByTestId("onepassword-step");
    expect(step.textContent).toContain("a folder it sits in");
    expect(step.textContent).not.toContain("cannot find");
    expect(button("Check again")).toBeTruthy();
  });

  it("shows when the CLI was updated and re-checked by itself", async () => {
    setup({ ...statuses.connected, repinnedAt: Date.UTC(2026, 10, 19, 12, 0, 0) });
    const note = await screen.findByTestId("onepassword-repinned");
    expect(note.textContent).toContain("1Password CLI updated and re-checked");
    expect(note.textContent).toContain("2026");
  });

  it("not integrated: names the exact app setting", async () => {
    setup(statuses.not_integrated);
    await check(userEvent.setup());
    const step = await screen.findByTestId("onepassword-step");
    expect(step.textContent).toContain("Integrate with 1Password CLI");
    expect(step.textContent).toContain("Developer");
    expect(button("Check again")).toBeTruthy();
    expect(button("Use 1Password in Psyche")).toBeNull();
  });

  it("locked: unlock the app", async () => {
    setup(statuses.locked);
    await check(userEvent.setup());
    expect((await screen.findByTestId("onepassword-step")).textContent).toContain(
      "Unlock the 1Password app",
    );
    expect(button("Check again")).toBeTruthy();
    expect(button("Test connection")).toBeNull();
  });

  it("error: check again or reinstall op", async () => {
    setup(statuses.error);
    await check(userEvent.setup());
    expect((await screen.findByTestId("onepassword-step")).textContent).toContain("reinstall op");
    expect(button("Check again")).toBeTruthy();
  });

  it("signed in: names the account and offers to use 1Password, plus the test", async () => {
    setup(statuses.signed_in);
    await check(userEvent.setup());
    expect((await screen.findByTestId("onepassword-step")).textContent).toContain(
      "owner@example.com (my.1password.com)",
    );
    expect(button("Use 1Password in Psyche")).toBeTruthy();
    expect(button("Test connection")).toBeTruthy();
    expect(button("Disconnect")).toBeNull();
    expect(button("Check again")).toBeNull();
  });

  it("connected: test and disconnect, no connect", async () => {
    setup(statuses.connected);
    await screen.findByText(/read only/);
    expect(button("Disconnect")).toBeTruthy();
    expect(button("Test connection")).toBeTruthy();
    expect(button("Use 1Password in Psyche")).toBeNull();
  });

  it("set in config.json: no buttons, says where to change it", async () => {
    setup(statuses.config);
    await screen.findByText(/config\.json/);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("actions", () => {
  it("opens the guide through the desktop shell, not in the page", async () => {
    const s = setup(statuses.not_integrated);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open the guide" }));
    expect(s.openExternal).toHaveBeenCalledWith(ONEPASSWORD_GUIDE_URL);
    expect(ONEPASSWORD_GUIDE_URL.startsWith("https://developer.1password.com/")).toBe(true);
  });

  it("Check again asks the Gateway for the state again", async () => {
    const s = setup(statuses.locked);
    await check(userEvent.setup());
    await waitFor(() =>
      expect(
        callsOf(s.gw(), "vault.onePassword.status").some(
          (c) => (c.params as { probe?: boolean }).probe === true,
        ),
      ).toBe(true),
    );
  });

  it("Test connection shows a count and nothing else", async () => {
    const s = setup(statuses.signed_in);
    const user = userEvent.setup();
    await check(user);
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    const ok = await screen.findByRole("status");
    expect(ok.textContent).toBe("Connected. Found 3 vaults.");
    expect(callsOf(s.gw(), "vault.onePassword.test")).toHaveLength(1);
  });

  it("connects, then disconnects, with plain calls (no presence step)", async () => {
    const s = setup(statuses.signed_in);
    const user = userEvent.setup();
    await check(user);
    await user.click(await screen.findByRole("button", { name: "Use 1Password in Psyche" }));
    await screen.findByRole("button", { name: "Disconnect" });
    expect(button("Use 1Password in Psyche")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await screen.findByRole("button", { name: "Check" });
    expect(callsOf(s.gw(), "vault.onePassword.connect")).toHaveLength(1);
    expect(callsOf(s.gw(), "vault.onePassword.disconnect")).toHaveLength(1);
    // Nothing but empty params ever goes to the Gateway: no token, no path.
    for (const c of s.gw().calls.filter((x) => x.method.startsWith("vault.onePassword."))) {
      expect(Object.keys(c.params as object).filter((k) => k !== "probe")).toEqual([]);
    }
  });

  it("a failed test shows the Gateway's sentence, not a raw error", async () => {
    const s = setup(statuses.signed_in);
    const user = userEvent.setup();
    await check(user);
    await screen.findByRole("button", { name: "Test connection" });
    s.gw().failNext("vault.onePassword.test", "unavailable", "1Password could not list vaults");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The test did not work: 1Password could not list vaults",
    );
  });
});

describe("who may use it", () => {
  it("a non-admin device sees the admin-only sentence and no controls", async () => {
    setup(statuses.signed_in, {
      fail: (g) => g.failNext("vault.onePassword.status", "forbidden", "needs operator.admin"),
    });
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Only an administrator device can do this.")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("credential events", () => {
  it("do not reload the 1Password status (that would run op again)", async () => {
    const s = setup(statuses.connected);
    await screen.findByText(/read only/);
    const before = callsOf(s.gw(), "vault.onePassword.status").length;
    s.gw().emit("credential.updated", {
      credentialId: "cred_1",
      change: "rotated",
      credential: null,
      ownerConnectorId: null,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(callsOf(s.gw(), "vault.onePassword.status")).toHaveLength(before);
  });
});
