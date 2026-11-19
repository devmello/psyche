import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { ConnectorsSection } from "../src/screens/settings/ConnectorsSection.tsx";
import {
  GOOGLE_CLIENT_DOCS_URL,
  googleClientIdProblem,
} from "../src/screens/settings/GoogleClientFields.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings → Connectors → Add connector → Google: the owner's own OAuth client, then sign-in. */

const ID = "1234567890-abc.apps.googleusercontent.com";
const SECRET = "GOCSPX-test-secret-0123456789";

function setup(googleClient: FixtureWorld["googleClient"], edit?: (g: MockGateway) => void) {
  let gw: MockGateway | null = null;
  const openExternal = vi.fn();
  render(
    <StoryWorld
      edit={(w) => {
        w.googleClient = googleClient;
      }}
      onGateway={(g) => {
        gw = g;
        edit?.(g);
      }}
      slots={{ openExternal }}
    >
      <ConnectorsSection />
    </StoryWorld>,
  );
  return {
    openExternal,
    calls: (method: string) =>
      (gw as MockGateway | null)?.calls.filter((c) => c.method === method) ?? [],
  };
}

async function pickGoogle() {
  await userEvent.click(await screen.findByRole("button", { name: "Add connector" }));
  await userEvent.click(await screen.findByRole("button", { name: /^Google/ }));
}

const connectButton = () =>
  screen.getByRole("button", { name: "Continue to sign in" }) as HTMLButtonElement;

describe("googleClientIdProblem", () => {
  it.each([
    [ID, null],
    [`  ${ID}  `, null],
    ["", "empty"],
    ["   ", "empty"],
    ["https://evil.example", "shape"],
    [`${ID}.evil.test`, "shape"],
    ["abc.apps.googleusercontent.com extra", "shape"],
    ["GOCSPX-this-is-the-secret", "shape"],
  ])("%j -> %s", (raw, expected) => {
    expect(googleClientIdProblem(raw)).toBe(expected);
  });
});

describe("Connect Google in Settings", () => {
  it("asks for the client first: Connect stays off until the id is a Google client id", async () => {
    const s = setup(null);
    await pickGoogle();
    const field = await screen.findByLabelText("Client ID");
    expect(screen.getByText(/Psyche has no Google client of its own/)).toBeTruthy();
    expect(connectButton().disabled).toBe(true);

    await userEvent.type(field, "https://evil.example");
    expect((await screen.findByRole("alert")).textContent).toMatch(/isn't a Google client ID/);
    expect(connectButton().disabled).toBe(true);

    await userEvent.clear(field);
    await userEvent.type(field, ID);
    expect(connectButton().disabled).toBe(false);
    expect(s.calls("connectors.connect")).toHaveLength(0);
  });

  it("saves the client (secret write-only), then starts the sign-in", async () => {
    const s = setup(null);
    await pickGoogle();
    await userEvent.type(await screen.findByLabelText("Client ID"), ID);
    const secret = screen.getByLabelText("Client secret") as HTMLInputElement;
    expect(secret.type).toBe("password");
    await userEvent.type(secret, SECRET);
    await userEvent.click(connectButton());

    await waitFor(() => expect(s.calls("connectors.connect")).toHaveLength(1));
    expect(s.calls("connectors.googleClient.set")[0]?.params).toEqual({
      clientId: ID,
      clientSecret: SECRET,
    });
    // The sign-in page opens in the owner's browser and the UI never claims Connected early.
    expect(await screen.findByTestId("connect-signing-in")).toBeTruthy();
    expect(screen.queryByText(/is connected/)).toBeNull();
    // The secret is not in the page once it is sent.
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("leaves the secret out of the call when it is empty", async () => {
    const s = setup(null);
    await pickGoogle();
    await userEvent.type(await screen.findByLabelText("Client ID"), ID);
    await userEvent.click(connectButton());
    await waitFor(() => expect(s.calls("connectors.googleClient.set")).toHaveLength(1));
    expect(s.calls("connectors.googleClient.set")[0]?.params).toEqual({ clientId: ID });
  });

  it("does not sign in when saving the client fails, and says why", async () => {
    const s = setup(null, (g) =>
      g.failNext("connectors.googleClient.set", "unavailable", "the vault is locked"),
    );
    await pickGoogle();
    await userEvent.type(await screen.findByLabelText("Client ID"), ID);
    await userEvent.click(connectButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Couldn't save the Google client/,
    );
    expect(s.calls("connectors.connect")).toHaveLength(0);
    expect(connectButton().disabled).toBe(false);
  });

  it("shows the Gateway's reason when Google must be disconnected before the client changes", async () => {
    const reason =
      "Google is connected with another client. Disconnect Google first, then change the client.";
    const s = setup(null, (g) => g.failNext("connectors.googleClient.set", "conflict", reason));
    await pickGoogle();
    await userEvent.type(await screen.findByLabelText("Client ID"), ID);
    await userEvent.click(connectButton());
    expect((await screen.findByRole("alert")).textContent).toContain("Disconnect Google first");
    expect(s.calls("connectors.connect")).toHaveLength(0);
  });

  it("a client saved here is reused: Connect is ready, and it can be swapped", async () => {
    const s = setup({ clientId: ID, hasSecret: true, source: "app" });
    await pickGoogle();
    expect(await screen.findByText(`Using your Google client ${ID}.`)).toBeTruthy();
    expect(screen.queryByLabelText("Client ID")).toBeNull();
    expect(connectButton().disabled).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Use a different client" }));
    expect(await screen.findByLabelText("Client ID")).toBeTruthy();
    expect(connectButton().disabled).toBe(true);
    expect(s.calls("connectors.googleClient.set")).toHaveLength(0);
  });

  it("a client from config.json is shown but cannot be replaced here", async () => {
    const s = setup({ clientId: ID, hasSecret: false, source: "config" });
    await pickGoogle();
    expect(await screen.findByText(/It's set in config.json or the environment/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use a different client" })).toBeNull();
    await userEvent.click(connectButton());
    await waitFor(() => expect(s.calls("connectors.connect")).toHaveLength(1));
    expect(s.calls("connectors.googleClient.set")).toHaveLength(0);
  });

  it("opens Google's docs for creating a client through the desktop shell", async () => {
    const s = setup(null);
    await pickGoogle();
    await userEvent.click(await screen.findByRole("button", { name: "How to create one" }));
    expect(s.openExternal).toHaveBeenCalledWith(GOOGLE_CLIENT_DOCS_URL);
    expect(GOOGLE_CLIENT_DOCS_URL.startsWith("https://developers.google.com/")).toBe(true);
  });

  it("other connectors never show the Google client fields", async () => {
    setup(null);
    await userEvent.click(await screen.findByRole("button", { name: "Add connector" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Microsoft/ }));
    expect(screen.queryByLabelText("Client ID")).toBeNull();
    expect(connectButton().disabled).toBe(false);
  });
});
