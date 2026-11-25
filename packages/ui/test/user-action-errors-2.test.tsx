import type { LinkSetupStatus } from "@psyche/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { InboxScreen } from "../src/screens/inbox/InboxScreen.tsx";
import {
  LinkSetupPanel,
  type LinkSetupView,
} from "../src/screens/settings/CredentialLinkSetup.tsx";
import { ServerSection } from "../src/screens/settings/ServerSection.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/**
 * User actions that used to drop their error now say why in a toast: opening the remote-access
 * docs, opening Link's sign-in page, and marking a notification read (from the row and from a
 * specialist result). Each case makes the call reject and reads the message the owner sees.
 */

function gatewayOf(ref: { current?: MockGateway }) {
  return () => {
    if (ref.current === undefined) throw new Error("gateway not ready");
    return ref.current;
  };
}

const rejectOpen = () => Promise.reject(new Error("no browser is available"));

describe("user actions that fail say why", () => {
  it("opening the remote-access docs that fails says why", async () => {
    const user = userEvent.setup();
    render(
      <StoryWorld slots={{ openExternal: rejectOpen }}>
        <ServerSection status={undefined} />
      </StoryWorld>,
    );
    await user.click(await screen.findByRole("button", { name: "Set up" }));
    expect(
      await screen.findByText("Psyche couldn't open the page (no browser is available)."),
    ).toBeTruthy();
  });

  it("opening Link's sign-in page that fails says why", async () => {
    const status: LinkSetupStatus = {
      state: "signing_in",
      cli: { path: "/opt/homebrew/bin/link-cli", source: "saved" },
      candidates: [],
      signIn: {
        verificationUrl: "https://login.link.com/device?c=1",
        phrase: "blue-otter-moon",
        expiresAt: 0,
      },
    };
    const view: LinkSetupView = {
      status,
      onConnect: async () => {},
      onSignIn: async () => {},
      onDisconnect: async () => {},
      onRecheck: () => {},
    };
    render(
      <StoryWorld slots={{ openExternal: rejectOpen }}>
        <LinkSetupPanel view={view} />
      </StoryWorld>,
    );
    fireEvent.click(await screen.findByRole("link"));
    expect(
      await screen.findByText("Psyche couldn't open the page (no browser is available)."),
    ).toBeTruthy();
  });

  it("marking a notification read from its row that fails says why", async () => {
    const user = userEvent.setup();
    const ref: { current?: MockGateway } = {};
    render(
      <StoryWorld onGateway={(g) => (ref.current = g)}>
        <InboxScreen now={STORY_NOW} />
      </StoryWorld>,
    );
    const mark = (await screen.findAllByRole("button", { name: /^Mark ".*" read$/ }))[0];
    if (mark === undefined) throw new Error("no unread notification to mark");
    gatewayOf(ref)().failNext("notifications.markRead", "unavailable", "the inbox is locked");
    await user.click(mark);
    expect(
      await screen.findByText("Psyche couldn't mark these read (the inbox is locked)."),
    ).toBeTruthy();
  });

  it("marking a specialist result read that fails says why", async () => {
    const user = userEvent.setup();
    const ref: { current?: MockGateway } = {};
    render(
      <StoryWorld onGateway={(g) => (ref.current = g)}>
        <InboxScreen now={STORY_NOW} />
      </StoryWorld>,
    );
    const open = (await screen.findAllByRole("button", { name: "Open" }))[0];
    if (open === undefined) throw new Error("no specialist result to open");
    gatewayOf(ref)().failNext("notifications.markRead", "unavailable", "the inbox is locked");
    await user.click(open);
    await waitFor(() =>
      expect(document.body.textContent ?? "").toContain(
        "Psyche couldn't mark these read (the inbox is locked).",
      ),
    );
  });
});
