import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import { assertNoSecrets, registerSecret, unregisterSecret } from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeConnectors } from "../../../apps/gateway/src/compose/connectors.ts";
import type { ComposeServices } from "../../../apps/gateway/src/compose/services.ts";
import { MAIN, ScriptedModel, UTILITY } from "../walking-skeleton/scripted-model.ts";
import { ACCESS_TOKEN, CLIENT_ID, FakeGoogle, OWNER, REFRESH_TOKEN } from "./fake-google.ts";
import { type PartsSkeleton, startWithParts } from "./harness.ts";

/**
 * #505: Google's connect flow as Settings and onboarding drive it, over the wire. Consent opens in
 * the system browser and `connectors.connect` answers at once (signing in); the loopback callback
 * finishes it as `connectors.updated`; tokens land in the vault as a connector-owned item; the
 * record survives a restart; Disconnect revokes. The fake Google plays the browser and the
 * token / revoke endpoints. Each `it` depends on the previous.
 */

type Json = Record<string, unknown>;
const ID = "google-1";
interface Wire {
  id: string;
  status: string;
  account: string | null;
  scopes: string[];
  scopeMode: string;
}
interface Updated {
  connector: Wire;
  reason: string;
}

const fake = new FakeGoogle();
const opened: URL[] = [];
let home: string;
let sk: PartsSkeleton;
let services: ComposeServices;

async function boot(google: { clientId?: string }): Promise<PartsSkeleton> {
  const booted = await startWithParts({
    home,
    // The real vault: tokens become a connector-owned oauth_token item (G13).
    vault: { keyFile: join(home, "vault.key"), argon2: { memory: 64, passes: 1, parallelism: 1 } },
    model: { provider: new ScriptedModel(), model: MAIN, utilityModel: UTILITY },
    parts: [
      (s) => {
        services = s;
        return composeConnectors(s, {
          fetch: fake.fetch,
          // The owner's browser opens the page; the test plays the consent later.
          openBrowser: async (url) => void opened.push(url),
          oauthTimeoutMs: 10_000,
          syncIntervalMs: 0,
          newId: () => ID,
          google,
        });
      },
    ],
  });
  // `psyched devices grant <id> …`: connecting accounts is an admin change (connectors.connect).
  updateDevice(booted.composed.db, booted.deviceId, {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
  return booted;
}

beforeAll(async () => {
  registerSecret(ACCESS_TOKEN, "google access token");
  registerSecret(REFRESH_TOKEN, "google refresh token");
  home = realpathSync(mkdtempSync(join(tmpdir(), "psyche-505-")));
  writeFileSync(join(home, "vault.key"), randomBytes(32), { mode: 0o600 });
  sk = await boot({ clientId: CLIENT_ID });
  await sk.composed.vault.setup();
});

afterAll(async () => {
  await sk?.stop();
  rmSync(home, { recursive: true, force: true });
  unregisterSecret(ACCESS_TOKEN);
  unregisterSecret(REFRESH_TOKEN);
});

describe("Google connect flow over the wire (#505)", () => {
  it("catalogue shows Google as configured", async () => {
    const { entries } = await sk.client.call<{ entries: Json[] }>("connectors.catalogue", {});
    expect(entries.find((e) => e.id === "google")).toMatchObject({
      configured: true,
      available: true,
    });
    // #529: a remote MCP preset has no connector implementation, so it is not offered.
    expect(entries.find((e) => e.id === "slack")).toMatchObject({ available: false });
    expect(entries.find((e) => e.id === "apple-notes")).toMatchObject({ available: true });
  });

  it("connect answers at once with the consent page; the record lists as signing in", async () => {
    const res = await sk.client.call<{
      connector: Wire;
      authorization?: { url: string; opened: boolean; expiresAt: number };
    }>("connectors.connect", { catalogueId: "google", scopeMode: "read" }, true);
    expect(res.connector).toMatchObject({ id: ID, status: "needs_auth", account: null });
    expect(res.authorization?.opened).toBe(true);
    const url = new URL(res.authorization?.url ?? "");
    expect(url.origin).toBe("https://accounts.google.com");
    expect(opened.map((u) => u.href)).toEqual([url.href]);
    // Scopes follow the picked mode: read-only never asks for send or modify.
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).toContain("gmail.readonly");
    expect(scope).not.toMatch(/gmail\.(send|modify)|calendar(\s|$)/);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const { connectors } = await sk.client.call<{ connectors: Wire[] }>("connectors.list", {});
    expect(connectors).toMatchObject([{ id: ID, status: "needs_auth" }]);
  });

  it("the loopback callback finishes it: connected with account, scopes, tokens in the vault", async () => {
    const from = sk.client.mark;
    await fake.openBrowser(opened[0] as URL);
    const done = await sk.client.event<Updated>(
      "connectors.updated",
      (p) => p.reason === "connected",
      from,
    );
    expect(done.connector).toMatchObject({
      id: ID,
      status: "connected",
      account: OWNER,
      scopeMode: "read",
    });
    expect(done.connector.scopes).toEqual(
      expect.arrayContaining([expect.stringMatching(/gmail\.readonly$/)]),
    );
    const { connectors } = await sk.client.call<{ connectors: Wire[] }>("connectors.list", {});
    expect(connectors).toMatchObject([{ id: ID, status: "connected", account: OWNER }]);
    // A connector-owned vault item, never the record or the wire.
    expect(services.vault.connectorItem(ID)).toMatchObject({ kind: "oauth_token" });
    assertNoSecrets(connectors, "connectors.list");
    assertNoSecrets(sk.client.events, "events");
    assertNoSecrets(sk.logs, "logs");
  });

  it("survives a restart: the record comes back connected with its tools, without consent", async () => {
    await sk.stop();
    opened.length = 0;
    // Booted without a client id: Google shows as not configured, yet the stored one restores.
    sk = await boot({});
    await sk.client.until(
      () => services.tools.list().some((t) => t.name === `mcp__${ID}__gmail_search_threads`),
      "restored tools",
    );
    const { connectors } = await sk.client.call<{ connectors: Wire[] }>("connectors.list", {});
    expect(connectors).toMatchObject([{ id: ID, status: "connected", account: OWNER }]);
    expect(opened).toEqual([]);
    const { entries } = await sk.client.call<{ entries: Json[] }>("connectors.catalogue", {});
    expect(entries.find((e) => e.id === "google")?.configured).toBe(false);
    await expect(
      sk.client.call("connectors.connect", { catalogueId: "google", scopeMode: "read" }, true),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("disconnect revokes at Google and removes the vault item", async () => {
    // Revoking reads the refresh token, so the vault must be open (it locks on restart).
    await sk.composed.vault.unlock("disconnect google");
    const before = fake.requests.length;
    const from = sk.client.mark;
    const res = await sk.client.call<{ connector: Wire }>(
      "connectors.disconnect",
      { connectorId: ID },
      true,
    );
    expect(res.connector.status).toBe("disconnected");
    const revoked = fake.requests
      .slice(before)
      .filter((r) => r.url.href === "https://oauth2.googleapis.com/revoke");
    expect(revoked).toHaveLength(1);
    await sk.client.event<Updated>("connectors.updated", (p) => p.reason === "disconnected", from);
    expect(services.vault.connectorItem(ID)).toBeUndefined();
    expect(services.tools.list().some((t) => t.name.startsWith(`mcp__${ID}__`))).toBe(false);
  });
});
