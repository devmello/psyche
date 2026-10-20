import { assertNoSecrets, clearSecrets, registerSecret } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectorSlug, VaultTokenVault } from "../src/index.ts";
import { type Harness, makeHarness } from "./helpers.ts";

const ACCESS = "ya29.connector-access-0001";
const REFRESH = "1//connector-refresh-0001";
let h: Harness;
let tokens: VaultTokenVault;
beforeEach(async () => {
  h = makeHarness();
  await h.vault.setup();
  tokens = new VaultTokenVault(h.vault, { bindings: () => [{ host: "gmail.googleapis.com" }] });
  registerSecret(ACCESS, "access");
  registerSecret(REFRESH, "refresh");
});
afterEach(() => {
  h.cleanup();
  clearSecrets();
});

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const saved = {
  accessToken: ACCESS,
  refreshToken: REFRESH,
  expiresAt: T0 + 3_600_000,
  scope: "https://www.googleapis.com/auth/gmail.readonly openid",
  tokenType: "Bearer",
  obtainedAt: T0,
};

describe("connector TokenVault on the vault (G13)", () => {
  it("stores tokens as a connector-owned oauth_token item and loads them back", async () => {
    expect(await tokens.load("con_gmail")).toBeUndefined();
    await tokens.save("con_gmail", saved);
    const meta = h.vault.connectorItem("con_gmail");
    expect(meta).toMatchObject({
      kind: "oauth_token",
      slug: connectorSlug("con_gmail"),
      ownerConnectorId: "con_gmail",
      bindings: [{ connector: "con_gmail" }, { host: "gmail.googleapis.com" }],
    });
    expect(await tokens.load("con_gmail")).toEqual(saved);
    assertNoSecrets(await h.vault.list(), "metadata");
    assertNoSecrets(await h.audit.list(), "audit");
    expect(h.vault.uses(meta?.id ?? "")[0]).toMatchObject({
      executor: "connector",
      target: "con_gmail",
      outcome: "filled",
    });
  });

  it("survives a Gateway restart", async () => {
    await tokens.save("con_gmail", saved);
    h.vault.lock();
    const again = h.reopen();
    await again.unlock("restart");
    expect(await new VaultTokenVault(again).load("con_gmail")).toEqual(saved);
    again.lock();
  });

  it("replaces tokens on refresh; old values stay masked", async () => {
    await tokens.save("con_gmail", saved);
    const events: string[] = [];
    h.vault.on("credential.updated", (e) => events.push(e.change));
    await tokens.save("con_gmail", {
      accessToken: "ya29.connector-access-0002",
      refreshToken: "1//connector-refresh-0002",
    });
    expect(await tokens.load("con_gmail")).toEqual({
      accessToken: "ya29.connector-access-0002",
      refreshToken: "1//connector-refresh-0002",
    });
    expect(events).toEqual(["rotated", "used"]);
    expect(h.vault.redact(`old ${ACCESS} ${REFRESH}`)).toBe("old ••• •••");
  });

  it("disconnect revokes the item and emits the invalidation event", async () => {
    await tokens.save("con_gmail", saved);
    const revoked: string[] = [];
    h.vault.onRevoked((e) => revoked.push(`${e.connectorId}:${e.reason}`));
    await tokens.clear("con_gmail");
    expect(revoked).toEqual(["con_gmail:disconnect"]);
    expect(await tokens.load("con_gmail")).toBeUndefined();
    await tokens.clear("con_gmail"); // no item: nothing to do
  });

  it("only the owning connector reads its tokens; a locked vault reads nothing", async () => {
    await tokens.save("con_gmail", saved);
    const id = h.vault.connectorItem("con_gmail")?.id ?? "";
    await expect(h.vault.connectorTokens(id, "con_slack")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      h.vault.replaceConnectorTokens(id, "con_slack", { accessToken: "x-123456" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    h.vault.lock();
    await expect(tokens.load("con_gmail")).rejects.toMatchObject({ code: "unavailable" });
  });
});
