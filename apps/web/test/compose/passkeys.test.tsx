import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ComposedGateway, composeGateway } from "@psyche/gateway/compose";
import { FakeModelProvider } from "@psyche/testing";
import { GatewayProvider, UiSlotsProvider } from "@psyche/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { adminClient, type TestClient } from "../../../gateway/test/helpers.ts";
import { SoftAuthenticator } from "../../../gateway/test/soft-authenticator.ts";
import type { GatewayEvent } from "../../src/client/connection.ts";
import { kitClient } from "../../src/compose/kit-client.ts";
import { PASSKEYS_UNAVAILABLE, PasskeysPanel } from "../../src/compose/passkeys.tsx";
import { settingsRoute } from "../../src/compose/settings.tsx";
import { browserAuthenticator, type PasskeyHost } from "../../src/lib/webauthn.ts";
import type { GatewayPort, ShellPlatform } from "../../src/shell/platform.ts";

/**
 * Issue #79 end to end: the web client's Passkeys panel and an approval that needs presence,
 * against a composed Gateway with an https `publicOrigin`. `navigator.credentials` is mocked by
 * software passkeys (the Gateway's `SoftAuthenticator`); no real browser runs.
 *
 * It runs in the node environment with happy-dom's globals added by hand: under the happy-dom
 * environment Vite's client transform rewrites `new URL("…", import.meta.url)`, which is how the
 * Gateway's packages find their migrations, into page URLs. Node's `URL` stays for the same reason.
 */
const dom = await vi.hoisted(async () => {
  const { URL } = globalThis;
  const { builtinEnvironments } = await import("vitest/runtime");
  const env = await builtinEnvironments["happy-dom"].setup(globalThis, {});
  Object.defineProperty(globalThis, "URL", { value: URL, configurable: true, writable: true });
  return env;
});
afterAll(() => dom.teardown(globalThis));

const ORIGIN = "https://psyche.example.test";
const RP_ID = "psyche.example.test";

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  cleanup();
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup(publicOrigin: string | null = ORIGIN) {
  home = mkdtempSync(join(tmpdir(), "psyche-web-passkeys-"));
  composed = await composeGateway({
    env: {},
    logger: { log() {} },
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null, publicOrigin },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  const devices = await owner.call<{ devices: { id: string; scopes: string[] }[] }>(
    "devices.list",
    {},
  );
  const deviceId = devices.devices.find((d) => d.scopes.includes("operator.admin"))?.id as string;
  return { owner, deviceId };
}

/** The shell's port over the Gateway's frame client, paired as the owner's admin device. */
function portOver(owner: TestClient): GatewayPort {
  return {
    getStatus: async () => ({ health: "ok", phase: "paired", attempt: 0 }),
    onStatus: () => () => undefined,
    onResync: () => () => undefined,
    async call(method, params, options) {
      const res = await owner.request(method, params, options?.idempotencyKey);
      if (res.ok !== true) throw res.error;
      return res.payload;
    },
    onEvent(cb) {
      const onMessage = (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as GatewayEvent & { type: string };
        if (frame.type === "event") cb(frame);
      };
      owner.ws.on("message", onMessage);
      return () => owner.ws.off("message", onMessage);
    },
  };
}

/** `navigator.credentials` backed by software passkeys bound to the Gateway's origin. */
function mockedNavigator() {
  const passkeys: SoftAuthenticator[] = [];
  // The JSON helpers below are the identity, so `publicKey` is still the options JSON.
  const credentials = {
    create: vi.fn(async (o: CredentialCreationOptions) => {
      const a = new SoftAuthenticator(RP_ID, ORIGIN);
      passkeys.push(a);
      const options = o.publicKey as unknown as { challenge: string };
      return { toJSON: () => a.create(options) };
    }),
    get: vi.fn(async (o: CredentialRequestOptions) => {
      const options = o.publicKey as unknown as {
        challenge: string;
        allowCredentials?: { id: string }[];
      };
      const allowed = new Set(options.allowCredentials?.map((c) => c.id));
      const a = passkeys.find((p) => allowed.has(p.id));
      if (!a) throw new DOMException("no passkey", "NotAllowedError");
      return { toJSON: () => a.get(options.challenge) };
    }),
  };
  // The real helpers turn base64url into buffers; the software passkeys take the JSON as is.
  const authenticator = browserAuthenticator({
    isSecureContext: true,
    navigator: { credentials },
    PublicKeyCredential: {
      parseCreationOptionsFromJSON: (o) => o,
      parseRequestOptionsFromJSON: (o) => o,
    },
  });
  if (!authenticator) throw new Error("no authenticator");
  return { credentials, authenticator };
}

function renderPanel(owner: TestClient, host: PasskeyHost | undefined) {
  const port = portOver(owner);
  render(
    <GatewayProvider client={kitClient(port, host)}>
      <PasskeysPanel host={host} />
    </GatewayProvider>,
  );
}

describe("Settings → Passkeys against the Gateway (issue #79)", () => {
  it("adds a first passkey, confirms with it to add a second, and removes one", async () => {
    const { owner, deviceId } = await setup();
    const { credentials, authenticator } = mockedNavigator();
    renderPanel(owner, { deviceId: async () => deviceId, authenticator });

    expect(await screen.findByText("No passkeys on this browser yet.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText(/^Added Laptop\./)).toBeTruthy();
    expect(credentials.create).toHaveBeenCalledTimes(1);
    expect(credentials.get).not.toHaveBeenCalled();
    const list = await screen.findByRole("list", { name: "Passkeys" });
    expect(within(list).getByText("Laptop")).toBeTruthy();

    // A second one needs an assertion with the first (passkeys.reauth.begin → get).
    expect(screen.getByText("You'll confirm with an existing passkey first.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Phone" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText(/^Added Phone\./)).toBeTruthy();
    expect(credentials.get).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Passkeys" })).getAllByRole("listitem"),
      ).toHaveLength(2),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Laptop" }));
    expect(await screen.findByText("Removed Laptop.")).toBeTruthy();
    expect(credentials.get).toHaveBeenCalledTimes(2);
    const left = await owner.call<{ passkeys: { name: string }[] }>("passkeys.list", {});
    expect(left.passkeys.map((p) => p.name)).toEqual(["Phone"]);
  });

  it("explains a cancelled prompt and changes nothing", async () => {
    const { owner, deviceId } = await setup();
    const { credentials, authenticator } = mockedNavigator();
    credentials.create.mockRejectedValueOnce(new DOMException("cancelled", "NotAllowedError"));
    renderPanel(owner, { deviceId: async () => deviceId, authenticator });
    fireEvent.click(await screen.findByRole("button", { name: "Add a passkey" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cancelled or timed out/);
    expect((await owner.call<{ passkeys: unknown[] }>("passkeys.list", {})).passkeys).toEqual([]);
  });

  it("shows a short explanation, not an error, without an https publicOrigin", async () => {
    const { owner, deviceId } = await setup(null);
    const { authenticator } = mockedNavigator();
    renderPanel(owner, { deviceId: async () => deviceId, authenticator });
    expect((await screen.findByTestId("passkeys-unavailable")).textContent).toBe(
      PASSKEYS_UNAVAILABLE,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
  });
});

describe("a security setting approved with a passkey (issue #79)", () => {
  it("shows the policy_change card, answers it with presence and saves with the approvalId", async () => {
    const { owner, deviceId } = await setup();
    const { credentials, authenticator } = mockedNavigator();
    const host: PasskeyHost = { deviceId: async () => deviceId, authenticator };
    const port = portOver(owner);
    const platform: ShellPlatform = {
      kind: "web",
      gateway: port,
      storage: { get: () => null, set: () => undefined },
      notify: { show: () => undefined },
      passkeys: host,
    };
    const answers: unknown[] = [];
    const call = port.call;
    port.call = (method, params, options) => {
      if (method === "approvals.answer") answers.push(params);
      return call(method, params, options);
    };

    render(
      <GatewayProvider client={kitClient(port, host)}>
        <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
          {settingsRoute("/settings/devices", () => undefined, platform)}
        </UiSlotsProvider>
      </GatewayProvider>,
    );
    // Register this browser's passkey from Settings → Devices & nodes.
    fireEvent.click(await screen.findByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText(/^Added Passkey\./)).toBeTruthy();
    cleanup();

    render(
      <GatewayProvider client={kitClient(port, host)}>
        <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
          {settingsRoute("/settings/files", () => undefined, platform)}
        </UiSlotsProvider>
      </GatewayProvider>,
    );
    const share = await screen.findByLabelText("Share a folder");
    fireEvent.change(share, { target: { value: "/Users/me/Taxes" } });
    fireEvent.keyDown(share, { key: "Enter" });
    const banner = await screen.findByTestId("settings-approval", {}, { timeout: 4000 });
    await waitFor(() => expect(within(banner).queryByText("Loading the approval…")).toBeNull());
    fireEvent.click(within(banner).getByRole("radio", { name: "Allow once" }));
    const button = within(banner).getByRole("button", { name: "Allow with scope" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button, { detail: 1 }); // a pointer click; the card ignores keyboard clicks

    expect(
      await screen.findByText("Saved permissions.policy.", {}, { timeout: 4000 }),
    ).toBeTruthy();
    expect(credentials.get).toHaveBeenCalledTimes(1);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      decision: "approve",
      presence: { kind: "webauthn", deviceId, payload: { credentialId: expect.any(String) } },
    });
    const saved = await owner.call<{ settings: Record<string, { folders?: unknown[] }> }>(
      "settings.get",
      { keys: ["permissions.policy"] },
    );
    expect(saved.settings["permissions.policy"]?.folders).toEqual([
      { path: "/Users/me/Taxes", mode: "ro" },
    ]);
  });
});
