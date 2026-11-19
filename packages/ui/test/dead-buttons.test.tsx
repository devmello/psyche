// @vitest-environment happy-dom

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SoulMemoryPanel } from "../src/agent/SoulMemoryPanel.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { GoalsSection } from "../src/home/sections.tsx";
import { en } from "../src/i18n/messages/index.ts";
import { FeedScreen } from "../src/screens/feed/FeedScreen.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/**
 * The buttons from the dead-button audit: each one that stays reaches a handler that makes the
 * right Gateway call (or navigates), and the one that was removed is gone from every catalogue.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(ui: ReactElement) {
  let gateway: MockGateway | undefined;
  const navigate = vi.fn();
  const user = userEvent.setup();
  render(
    <StoryWorld onGateway={(g) => (gateway = g)} slots={{ navigate }}>
      {ui}
    </StoryWorld>,
  );
  const gw = () => {
    if (gateway === undefined) throw new Error("gateway not ready");
    return gateway;
  };
  const callsTo = (method: string) => gw().calls.filter((c) => c.method === method);
  return { callsTo, navigate, user };
}

describe("Memory → Export button", () => {
  it("calls memory.export and saves the zip as a download", async () => {
    const create = vi.fn((_blob: Blob) => "blob:psyche-memory");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { callsTo, user } = mount(<SoulMemoryPanel />);

    await user.click(await screen.findByRole("button", { name: /^Export$/ }));

    await waitFor(() => expect(callsTo("memory.export")).toHaveLength(1));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(click).toHaveBeenCalledTimes(1);
    const blob = create.mock.calls[0]?.[0];
    expect(blob?.type).toBe("application/zip");
    expect(await screen.findByText("Exported psyche-memory.zip.")).toBeTruthy();
  });
});

describe("Feed header buttons (Home's Today section)", () => {
  it("“What should I write about” opens the brief's instructions", async () => {
    const { navigate, user } = mount(<FeedScreen />);
    await user.click(await screen.findByRole("button", { name: /^What should I write about$/ }));
    expect(navigate).toHaveBeenCalledWith("/home/instructions");
  });

  it("“Schedule” opens the Scheduled screen", async () => {
    const { navigate, user } = mount(<FeedScreen />);
    await user.click(await screen.findByRole("button", { name: /^Schedule$/ }));
    expect(navigate).toHaveBeenCalledWith("/scheduled");
  });
});

describe("Home Goals → Add a goal (+) button", () => {
  it("opens the dialog and creates the goal with goals.create", async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld onGateway={(g) => (gateway = g)}>
        <GoalsSection onNavigate={onNavigate} />
      </StoryWorld>,
    );
    await user.click(await screen.findByRole("button", { name: /^Add a goal$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a goal" });
    await user.type(within(dialog).getByLabelText("Goal"), "Walk every day");
    await user.selectOptions(within(dialog).getByLabelText("Category"), "health");
    await user.click(within(dialog).getByRole("button", { name: /^Add a goal$/ }));

    await waitFor(() => {
      const calls = gateway?.calls.filter((c) => c.method === "goals.create") ?? [];
      expect(calls[0]?.params).toEqual({ title: "Walk every day", category: "health" });
    });
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(expect.stringMatching(/^\/goals\//)),
    );
  });
});

describe("removed: “Fork selection” shortcut", () => {
  it("has no catalogue strings left in any language", () => {
    expect(Object.keys(en)).not.toContain("shell.shortcut.forkSelection");
    expect(Object.keys(en)).not.toContain("web.shortcut.forkSelection");
    const dir = join(__dirname, "../src/i18n/messages");
    const files = [
      ...readdirSync(dir).filter((f) => f.endsWith(".ts")),
      ...readdirSync(join(dir, "locales"), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join("locales", f)),
    ];
    for (const f of files) {
      expect(readFileSync(join(dir, f), "utf8"), f).not.toContain("forkSelection");
    }
  });
});
