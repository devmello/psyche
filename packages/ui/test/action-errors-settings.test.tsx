import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { appleConnectors } from "../src/fixtures/settings.ts";
import { SourceFields } from "../src/memory/EverythingFields.tsx";
import { ConnectorsSection } from "../src/screens/settings/ConnectorsSection.tsx";
import { CredentialsSection } from "../src/screens/settings/CredentialsSection.tsx";
import { type McpState, useMcp } from "../src/screens/settings/use-mcp.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/**
 * Settings actions that used to swallow their error now show it next to the control: the MCP
 * secret cleanup (with a retry), a connector row's grant / check, the memory source switch and a
 * credential row's delete.
 */

function gatewayOf(ref: { current?: MockGateway }) {
  return () => {
    if (ref.current === undefined) throw new Error("gateway not ready");
    return ref.current;
  };
}

/** Holds the latest hook value for the test to call; shows the secret failure with its Retry. */
function McpProbe({ held }: { held: { mcp: McpState | null } }) {
  held.mcp = useMcp();
  const failure = held.mcp.secretFailure;
  return failure ? (
    <div>
      <p role="alert">{failure.message}</p>
      <button type="button" onClick={failure.retry}>
        Retry
      </button>
    </div>
  ) : null;
}

describe("settings actions show their failure", () => {
  it("turning on a memory source that fails says why, next to its switch", async () => {
    const user = userEvent.setup();
    render(
      <SourceFields
        value={{ optOut: {} } as never}
        onChange={() => undefined}
        indexed={new Set(["notes"]) as never}
        onEnable={() => Promise.reject(new Error("the source is locked"))}
      />,
    );
    const enable = (await screen.findAllByRole("button", { name: /^Let Psyche read/ }))[0];
    if (enable === undefined) throw new Error("no source to enable");
    await user.click(enable);
    expect(
      await screen.findByText("Psyche couldn't turn on Mail: the source is locked"),
    ).toBeTruthy();
  });

  it("a connector's grant that fails shows the error on its row", async () => {
    const user = userEvent.setup();
    const ref: { current?: MockGateway } = {};
    render(
      <StoryWorld
        edit={(w) => {
          w.connectors = appleConnectors();
        }}
        onGateway={(g) => (ref.current = g)}
      >
        <ConnectorsSection now={STORY_NOW} />
      </StoryWorld>,
    );
    const notes = await screen.findByRole("article", { name: "Apple Notes" });
    const fix = within(notes)
      .getAllByRole("button")
      .find((b) => b.getAttribute("aria-label")?.startsWith("Open System Settings") === true);
    if (fix === undefined) throw new Error("no fix button on the Apple Notes row");
    gatewayOf(ref)().failNext("connectors.connect", "unavailable", "the helper is busy");
    await user.click(fix);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Apple Notes"));
    expect(screen.getByRole("alert").textContent).toContain("the helper is busy");
  });

  it("a credential that fails to delete says why on its row", async () => {
    const user = userEvent.setup();
    const ref: { current?: MockGateway } = {};
    render(
      <StoryWorld onGateway={(g) => (ref.current = g)}>
        <CredentialsSection now={STORY_NOW} />
      </StoryWorld>,
    );
    const more = (await screen.findAllByRole("button", { name: /^More for / }))[0];
    if (more === undefined) throw new Error("no credential to delete");
    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog");
    gatewayOf(ref)().failNext("vault.delete", "unavailable", "the vault is locked");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Psyche couldn't delete");
    expect(alert.textContent).toContain("the vault is locked");
  });

  it("a secret left behind by a failed MCP probe says so, and Retry deletes it", async () => {
    const ref: { current?: MockGateway } = {};
    const held: { mcp: McpState | null } = { mcp: null };
    render(
      <StoryWorld onGateway={(g) => (ref.current = g)}>
        <McpProbe held={held} />
      </StoryWorld>,
    );
    await waitFor(() => expect(held.mcp).not.toBeNull());
    gatewayOf(ref)().failNext("mcp.probe", "unavailable", "the server did not start");
    gatewayOf(ref)().failNext("vault.delete", "unavailable", "the vault is locked");
    await act(async () => {
      held.mcp?.check(
        { id: "probe", name: "Probe", command: "x" } as never,
        [{ name: "probe-key", slug: "probe-key", token: "t" }] as never,
      );
    });
    expect(await screen.findByText(/couldn't delete a saved secret/)).toBeTruthy();
    await userEventRetry();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

async function userEventRetry(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
}
