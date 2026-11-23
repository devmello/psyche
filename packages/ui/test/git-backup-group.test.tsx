import type { GitSyncResult } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Settings › Data › "Back up to git": the block, its outcome lines and the admin refusal. */

const call = vi.fn();
let query: { data: unknown; error: string | null; loading: boolean; reload: () => void };

vi.mock("../src/data/hooks.ts", () => ({
  useCall: () => call,
  useGatewayQuery: () => query,
}));

import { GitBackupGroup, gitOutcomeText } from "../src/screens/settings/GitBackupGroup.tsx";

const AT = "2026-11-23T09:00:00.000Z";
const OK: GitSyncResult = {
  at: AT,
  ok: true,
  committed: true,
  files: 2,
  pulled: false,
  pushed: true,
};

function gateway(config: { remote: string; branch: string; enabled: boolean }, last = null) {
  query = { data: { config, last }, error: null, loading: false, reload: () => {} };
}

beforeEach(() => {
  call.mockReset();
  query = { data: undefined, error: null, loading: true, reload: () => {} };
});

describe("gitOutcomeText", () => {
  it("says what was pushed, what was already up to date and what was pulled", () => {
    expect(gitOutcomeText(OK)).toBe("Backed up 2 files and pushed.");
    expect(gitOutcomeText({ ...OK, committed: false, files: 0, pushed: true })).toBe(
      "Nothing new to back up. The remote is up to date.",
    );
    expect(gitOutcomeText({ ...OK, committed: false, files: 0, pulled: true, pushed: false })).toBe(
      "Pulled changes from the remote. Nothing new to push.",
    );
  });

  it("names the blocked files and gives each failure its own sentence", () => {
    const blocked = gitOutcomeText({
      ...OK,
      ok: false,
      committed: false,
      files: 0,
      pushed: false,
      errorCode: "blocked_secret",
      blocked: ["memory/keys.md"],
    });
    expect(blocked).toContain("memory/keys.md");
    const codes = [
      "no_git",
      "no_remote",
      "not_enabled",
      "auth_failed",
      "remote_failed",
      "conflict",
      "failed",
    ] as const;
    const lines = codes.map((errorCode) =>
      gitOutcomeText({ ...OK, ok: false, committed: false, files: 0, pushed: false, errorCode }),
    );
    expect(new Set(lines).size).toBe(codes.length);
    for (const line of lines) expect(line.length).toBeGreaterThan(10);
  });
});

describe("GitBackupGroup", () => {
  it("renders nothing until the Gateway answers", () => {
    const { container } = render(<GitBackupGroup />);
    expect(container.textContent).toBe("");
  });

  it("keeps Sync now off until a remote is set and backup is on", async () => {
    gateway({ remote: "", branch: "main", enabled: false });
    render(<GitBackupGroup />);
    expect(screen.getByRole("button", { name: "Sync now" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("switch", { name: "Git backup on" })).toBeTruthy();
    expect(screen.getByText(/Never put a password in the URL/)).toBeTruthy();
  });

  it("runs a sync and shows the outcome", async () => {
    gateway({ remote: "git@example.com:me/memory.git", branch: "main", enabled: true });
    call.mockResolvedValueOnce(OK);
    render(<GitBackupGroup />);
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(call).toHaveBeenCalledWith("memory.gitSync.run", {});
    expect(await screen.findByText("Backed up 2 files and pushed.")).toBeTruthy();
  });

  it("saves the remote, branch and switch through memory.gitSync.set", async () => {
    gateway({ remote: "", branch: "main", enabled: false });
    call.mockResolvedValueOnce({
      remote: "/srv/memory.git",
      branch: "main",
      enabled: true,
    });
    render(<GitBackupGroup />);
    await userEvent.type(screen.getByRole("textbox", { name: "Remote" }), "/srv/memory.git");
    await userEvent.click(screen.getByRole("switch", { name: "Git backup on" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(call).toHaveBeenCalledWith("memory.gitSync.set", {
      remote: "/srv/memory.git",
      branch: "main",
      enabled: true,
    });
  });

  it("explains a refused save and locks the controls when the device lacks admin", async () => {
    gateway({ remote: "/srv/memory.git", branch: "main", enabled: true });
    call.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { code: "forbidden" }));
    render(<GitBackupGroup />);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByText("Git backup needs admin on this device.")).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Sync now" })).toHaveProperty("disabled", true);
  });
});
