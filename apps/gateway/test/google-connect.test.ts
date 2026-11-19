import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting } from "@psyche/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLIENT_ID,
  FakeGoogle,
  fixture,
} from "../../../packages/connectors/test/google/fake-google.ts";
import { composeConnectors } from "../src/compose/connectors.ts";
import { type ComposedGateway, composeGateway, vaultModelSetup } from "../src/compose/index.ts";
import type { Logger } from "../src/log.ts";
import { adminClient, desktopClient, ik, type TestClient } from "./helpers.ts";

/**
 * Settings → Connectors → Connect Google: the owner's own OAuth client (pasted in Settings), the
 * loopback + PKCE sign-in against a fake Google token endpoint (no network), tokens in the
 * vault only, and disconnect revoking and deleting them.
 */

const REFRESH = "1//fake-refresh-token-abcdef";
const SECRET = "GOCSPX-test-client-secret-0123456789";
const SLUG = "google-oauth-client";

let home = "";
let composed: ComposedGateway | undefined;
let g: FakeGoogle;
let consent: URL[] = [];
let logged: string[] = [];
const clients: TestClient[] = [];

const logger: Logger = {
  log: (level, message, data) => {
    logged.push(`${level} ${message} ${JSON.stringify(data ?? {})}`);
  },
};

async function compose(oauthTimeoutMs = 5000): Promise<ComposedGateway> {
  const keyFile = join(home, "vault.key");
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  composed = await composeGateway({
    env: { PSYCHE_VAULT_KEY_FILE: keyFile },
    logger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: vaultModelSetup({}),
    vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
    parts: [
      (s) =>
        composeConnectors(s, {
          fetch: g.fetch,
          openBrowser: (url) => {
            consent.push(url);
          },
          oauthTimeoutMs,
          syncIntervalMs: 0,
        }),
    ],
  });
  await composed.vault.setup();
  return composed;
}

async function owner(gw: ComposedGateway): Promise<TestClient> {
  const c = await adminClient(gw.gateway);
  clients.push(c);
  return c;
}

/** Plays the owner's browser after consent: Google redirects to the loopback receiver. */
async function approve(url: URL, state?: string): Promise<Response> {
  const q = url.searchParams;
  const code = `code-${g.codes.size + 1}`;
  g.codes.set(code, {
    challenge: q.get("code_challenge") ?? "",
    redirect: q.get("redirect_uri") ?? "",
    scope: q.get("scope") ?? "",
  });
  const back = new URL(q.get("redirect_uri") ?? "");
  back.searchParams.set("code", code);
  back.searchParams.set("state", state ?? q.get("state") ?? "");
  return fetch(back);
}

const statusOf = (f: { event?: unknown; payload?: unknown }): string | undefined =>
  (f.payload as { connector?: { status?: string } } | undefined)?.connector?.status;

async function startConnect(c: TestClient): Promise<{ id: string; url: URL }> {
  const before = consent.length;
  const res = (await c.call(
    "connectors.connect",
    { catalogueId: "google", scopeMode: "read_act" },
    ik(),
  )) as { connector: { id: string } };
  for (let i = 0; i < 100 && consent.length === before; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const url = consent.at(-1);
  if (url === undefined || consent.length === before) throw new Error("no consent page opened");
  return { id: res.connector.id, url };
}

const SAVE = { clientId: CLIENT_ID };

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "psyche-google-connect-")));
  g = new FakeGoogle();
  g.route("GET", "/gmail/v1/users/me/profile", fixture("profile"));
  consent = [];
  logged = [];
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop();
  composed = undefined;
  await rm(home, { recursive: true, force: true });
});

describe("the Google client in Settings", () => {
  it("is not configured at first, and connecting says to paste the client id", async () => {
    const c = await owner(await compose());
    expect(await c.call("connectors.googleClient", {})).toEqual({
      configured: false,
      hasSecret: false,
      source: null,
    });
    const res = await c.request(
      "connectors.connect",
      { catalogueId: "google", scopeMode: "read" },
      ik(),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: "unavailable", details: { reason: "not_configured" } });
    expect(consent).toHaveLength(0);
  });

  it("saves the id as an internal setting and the secret in the vault, never in settings", async () => {
    const gw = await compose();
    const c = await owner(gw);
    const set = (await c.call(
      "connectors.googleClient.set",
      { clientId: ` ${CLIENT_ID} `, clientSecret: SECRET },
      ik(),
    )) as { status: unknown };
    expect(set.status).toEqual({
      configured: true,
      clientId: CLIENT_ID,
      hasSecret: true,
      source: "app",
    });
    expect(await c.call("connectors.googleClient", {})).toEqual(set.status);
    // The secret is a vault item bound to Google's token endpoint ...
    const item = gw.vault.metaBySlug(SLUG);
    expect(item?.bindings).toEqual([{ origin: "https://oauth2.googleapis.com" }]);
    // ... the setting holds only its placeholder ...
    expect(getSetting(gw.gateway.context.db, "_connectors.googleClient")?.value).toEqual({
      clientId: CLIENT_ID,
      clientSecret: `{{cred:${SLUG}}}`,
    });
    // ... and nothing the owner or a device can read back carries it.
    const everything = JSON.stringify([
      await c.call("settings.get", {}),
      await c.call("connectors.googleClient", {}),
      await c.call("connectors.catalogue", {}),
      await c.call("connectors.list", {}),
      set,
      logged,
      await gw.audit.query({}),
      c.events,
    ]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("GOCSPX");
    // The audit row names the paired device that changed the client, and no secret.
    const rows = (await gw.audit.query({ kind: "connector.google_client_set" })) as {
      actor: { type: string; deviceId?: string };
      data: Record<string, unknown>;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor.type).toBe("device");
    expect(rows[0]?.actor.deviceId).toMatch(/^admin-/);
    expect(rows[0]?.data).toMatchObject({ secretChanged: true });
    const catalogue = (await c.call("connectors.catalogue", {})) as {
      entries: { id: string; configured?: boolean }[];
    };
    expect(catalogue.entries.find((e) => e.id === "google")?.configured).toBe(true);
  });

  it("refuses something that is not a Google client id, without echoing the secret", async () => {
    const c = await owner(await compose());
    for (const clientId of [
      "",
      "https://evil.example",
      "abc.apps.googleusercontent.com.evil.test",
    ]) {
      const res = await c.request(
        "connectors.googleClient.set",
        { clientId: clientId || " ", clientSecret: SECRET },
        ik(),
      );
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).not.toContain(SECRET);
    }
    expect(
      ((await c.call("connectors.googleClient", {})) as { configured: boolean }).configured,
    ).toBe(false);
  });

  it("a device without operator.admin gets forbidden for set, connect and disconnect", async () => {
    const gw = await compose();
    const plain = await desktopClient(gw.gateway);
    clients.push(plain);
    for (const [method, params] of [
      ["connectors.googleClient.set", SAVE],
      ["connectors.connect", { catalogueId: "google", scopeMode: "read" }],
      ["connectors.disconnect", { connectorId: "con_nope" }],
    ] as const) {
      const res = await plain.request(method, params, ik());
      expect(res.ok, method).toBe(false);
      expect(res.error, method).toMatchObject({ code: "forbidden" });
    }
    expect(consent).toHaveLength(0);
    // Reading the status is allowed.
    expect(await plain.call("connectors.googleClient", {})).toMatchObject({ configured: false });
  });

  it("a client from the environment wins and Settings cannot replace it", async () => {
    const keyFile = join(home, "vault.key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    composed = await composeGateway({
      env: { PSYCHE_VAULT_KEY_FILE: keyFile },
      logger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: vaultModelSetup({}),
      vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
      parts: [
        (s) =>
          composeConnectors(s, {
            fetch: g.fetch,
            google: { clientId: CLIENT_ID },
            syncIntervalMs: 0,
          }),
      ],
    });
    const c = await owner(composed);
    expect(await c.call("connectors.googleClient", {})).toEqual({
      configured: true,
      clientId: CLIENT_ID,
      hasSecret: false,
      source: "config",
    });
    const res = await c.request("connectors.googleClient.set", SAVE, ik());
    expect(res.error).toMatchObject({
      code: "conflict",
      details: { reason: "client_from_config" },
    });
  });
});

describe("the client's vault item", () => {
  it.each([
    ["an api_key bound to another origin", "api_key", [{ origin: "https://evil.example" }]],
    [
      "a login bound to Google's token endpoint",
      "login",
      [{ origin: "https://oauth2.googleapis.com" }],
    ],
    [
      "an api_key with an extra binding",
      "api_key",
      [{ origin: "https://oauth2.googleapis.com" }, { host: "evil.example" }],
    ],
  ] as const)(
    "never writes into the owner's item (%s); the secret lands in a fresh slug",
    async (_name, kind, bindings) => {
      const gw = await compose();
      const c = await owner(gw);
      const mine = await gw.vault.add({
        kind,
        name: "Google OAuth client",
        bindings: [...bindings],
        secret:
          kind === "login"
            ? { username: "me", password: "owner-password-1" }
            : { token: "owner-token-1" },
      });
      expect(mine.slug).toBe(SLUG);
      await c.call(
        "connectors.googleClient.set",
        { clientId: CLIENT_ID, clientSecret: SECRET },
        ik(),
      );

      // The owner's item is exactly as it was.
      const after = gw.vault.metaBySlug(SLUG);
      expect(after).toMatchObject({
        id: mine.id,
        kind: mine.kind,
        bindings: mine.bindings,
        updatedAt: mine.updatedAt,
      });
      // The secret is in a new item bound only to Google's token endpoint.
      const fresh = gw.vault.metaBySlug(`${SLUG}-2`);
      expect(fresh).toMatchObject({
        kind: "api_key",
        bindings: [{ origin: "https://oauth2.googleapis.com" }],
      });
      expect(getSetting(gw.gateway.context.db, "_connectors.googleClient")?.value).toEqual({
        clientId: CLIENT_ID,
        clientSecret: `{{cred:${SLUG}-2}}`,
      });
      // Saving again reuses the fresh item instead of minting -3.
      await c.call(
        "connectors.googleClient.set",
        { clientId: CLIENT_ID, clientSecret: `${SECRET}x` },
        ik(),
      );
      expect(gw.vault.metaBySlug(`${SLUG}-3`)).toBeUndefined();
    },
  );

  it("still reuses its own item on a second save", async () => {
    const gw = await compose();
    const c = await owner(gw);
    await c.call(
      "connectors.googleClient.set",
      { clientId: CLIENT_ID, clientSecret: SECRET },
      ik(),
    );
    const first = gw.vault.metaBySlug(SLUG);
    await c.call(
      "connectors.googleClient.set",
      { clientId: CLIENT_ID, clientSecret: `${SECRET}2` },
      ik(),
    );
    expect(gw.vault.metaBySlug(SLUG)?.id).toBe(first?.id);
    expect(gw.vault.metaBySlug(`${SLUG}-2`)).toBeUndefined();
  });
});

describe("changing the client", () => {
  const OTHER = "9876543210-xyz.apps.googleusercontent.com";

  it("a different client id needs its own secret; the old secret is never kept with it", async () => {
    const gw = await compose();
    const c = await owner(gw);
    await c.call(
      "connectors.googleClient.set",
      { clientId: CLIENT_ID, clientSecret: SECRET },
      ik(),
    );
    const res = await c.request("connectors.googleClient.set", { clientId: OTHER }, ik());
    expect(res.error).toMatchObject({
      code: "invalid_params",
      details: { reason: "secret_required" },
    });
    expect(((await c.call("connectors.googleClient", {})) as { clientId: string }).clientId).toBe(
      CLIENT_ID,
    );

    // With a new secret it goes through, and the stored placeholder is for the new secret.
    const ok = (await c.call(
      "connectors.googleClient.set",
      { clientId: OTHER, clientSecret: `${SECRET}-other` },
      ik(),
    )) as { status: { clientId: string; hasSecret: boolean } };
    expect(ok.status).toMatchObject({ clientId: OTHER, hasSecret: true });
    // The same id with no secret keeps the one it has.
    const same = (await c.call("connectors.googleClient.set", { clientId: OTHER }, ik())) as {
      status: { hasSecret: boolean };
    };
    expect(same.status.hasSecret).toBe(true);
  });

  it("is refused while Google is connected with a different client, and allowed after disconnect", async () => {
    const gw = await compose();
    const c = await owner(gw);
    await c.call("connectors.googleClient.set", SAVE, ik());
    const { id, url } = await startConnect(c);
    await approve(url);
    await c.waitForEvent((f) => f.event === "connectors.updated" && statusOf(f) === "connected");

    const res = await c.request(
      "connectors.googleClient.set",
      { clientId: OTHER, clientSecret: SECRET },
      ik(),
    );
    expect(res.error).toMatchObject({
      code: "conflict",
      details: { reason: "connected_with_other_client" },
    });
    expect(((await c.call("connectors.googleClient", {})) as { clientId: string }).clientId).toBe(
      CLIENT_ID,
    );
    expect(gw.vault.metaBySlug(SLUG)).toBeUndefined();
    // The same client id can be saved again while connected.
    await c.call("connectors.googleClient.set", SAVE, ik());

    await c.call("connectors.disconnect", { connectorId: id }, ik());
    await c.call("connectors.googleClient.set", { clientId: OTHER, clientSecret: SECRET }, ik());
    expect(((await c.call("connectors.googleClient", {})) as { clientId: string }).clientId).toBe(
      OTHER,
    );
  });
});

describe("Connect Google (loopback + PKCE against a fake Google)", () => {
  async function connectedGateway() {
    const gw = await compose();
    const c = await owner(gw);
    await c.call("connectors.googleClient.set", SAVE, ik());
    return { gw, c };
  }

  it("a forged state is refused and the real callback still completes; tokens land in the vault only", async () => {
    const { gw, c } = await connectedGateway();
    const { id, url } = await startConnect(c);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const forged = await approve(url, "forged-state");
    expect(forged.status).toBe(400);
    expect(g.requests.filter((r) => r.body.includes("authorization_code"))).toHaveLength(0);
    expect(gw.vault.connectorItem(id)).toBeUndefined();

    const ok = await approve(url);
    expect(ok.status).toBe(200);
    await c.waitForEvent((f) => f.event === "connectors.updated" && statusOf(f) === "connected");

    // The vault holds the sign-in as the connector's own item ...
    expect(gw.vault.connectorItem(id)).toBeDefined();
    // ... and no read path, event or log carries a token.
    const everything = JSON.stringify([
      await c.call("settings.get", {}),
      await c.call("connectors.list", {}),
      c.events,
      logged,
    ]);
    expect(everything).not.toContain(REFRESH);
    expect(everything).not.toContain(g.accessToken);
    expect(everything).toContain("owner@example.com");
    const list = (await c.call("connectors.list", {})) as {
      connectors: { id: string; status: string; account: string | null }[];
    };
    expect(list.connectors.find((x) => x.id === id)).toMatchObject({
      status: "connected",
      account: "owner@example.com",
    });
  });

  it("accepts exactly one callback: a second one is refused and the receiver is closed", async () => {
    const { c } = await connectedGateway();
    const { url } = await startConnect(c);
    expect((await approve(url)).status).toBe(200);
    await c.waitForEvent((f) => f.event === "connectors.updated" && statusOf(f) === "connected");
    const exchanges = g.requests.filter((r) => r.body.includes("authorization_code")).length;
    expect(exchanges).toBe(1);
    // The listener is gone: a replay cannot even connect.
    await expect(approve(url)).rejects.toThrow();
    expect(g.requests.filter((r) => r.body.includes("authorization_code"))).toHaveLength(exchanges);
  });

  it("times out when the owner never finishes, and keeps nothing", async () => {
    const gw = await compose(150);
    const c = await owner(gw);
    await c.call("connectors.googleClient.set", SAVE, ik());
    const { id, url } = await startConnect(c);
    const failed = await c.waitForEvent(
      (f) =>
        f.event === "connectors.updated" &&
        statusOf(f) !== undefined &&
        statusOf(f) !== "needs_auth" &&
        statusOf(f) !== "connected",
    );
    expect(statusOf(failed)).not.toBe("connected");
    expect(gw.vault.connectorItem(id)).toBeUndefined();
    // The receiver closed with the timeout: a late callback goes nowhere.
    await expect(approve(url)).rejects.toThrow();
    expect(g.requests.filter((r) => r.body.includes("authorization_code"))).toHaveLength(0);
  });

  it("disconnect revokes the token at Google and deletes it from the vault", async () => {
    const { gw, c } = await connectedGateway();
    const { id, url } = await startConnect(c);
    await approve(url);
    await c.waitForEvent((f) => f.event === "connectors.updated" && statusOf(f) === "connected");
    expect(gw.vault.connectorItem(id)).toBeDefined();

    await c.call("connectors.disconnect", { connectorId: id }, ik());
    const revoke = g.requests.find((r) => r.url.href === "https://oauth2.googleapis.com/revoke");
    expect(revoke?.body).toContain(encodeURIComponent(REFRESH));
    expect(gw.vault.connectorItem(id)).toBeUndefined();
    const list = (await c.call("connectors.list", {})) as {
      connectors: { id: string; status: string }[];
    };
    expect(list.connectors.find((x) => x.id === id)?.status).toBe("disconnected");
    expect(JSON.stringify([c.events, logged])).not.toContain(REFRESH);
  });

  it("with a saved secret, connect asks the credential card once and sends the secret only to Google's token endpoint", async () => {
    const gw = await compose();
    const c = await owner(gw);
    await c.call(
      "connectors.googleClient.set",
      { clientId: CLIENT_ID, clientSecret: SECRET },
      ik(),
    );
    const { id, url } = await startConnect(c);
    expect((await approve(url)).status).toBe(200);

    // The token exchange waits for the owner's plain tap on the credential card.
    let card: { id: string } | undefined;
    for (let i = 0; i < 100 && card === undefined; i++) {
      const pending = (await c.call("approvals.list", {})) as { approvals: { id: string }[] };
      card = pending.approvals[0];
      if (card === undefined) await new Promise((r) => setTimeout(r, 20));
    }
    if (card === undefined) throw new Error("no credential card");
    expect(g.requests.filter((r) => r.body.includes("authorization_code"))).toHaveLength(0);
    const { answerToken } = (await c.call("approvals.get", { approvalId: card.id })) as {
      answerToken?: string;
    };
    await new Promise((r) => setTimeout(r, 450)); // cards arm after 400 ms
    await c.call("approvals.answer", {
      approvalId: card.id,
      answerToken,
      decision: "approve",
      scope: "once",
    });
    await c.waitForEvent((f) => f.event === "connectors.updated" && statusOf(f) === "connected");

    const exchange = g.requests.filter((r) => r.body.includes("authorization_code"));
    expect(exchange).toHaveLength(1);
    expect(exchange[0]?.url.href).toBe("https://oauth2.googleapis.com/token");
    expect(new URLSearchParams(exchange[0]?.body).get("client_secret")).toBe(SECRET);
    // The secret appears in no other request, and in nothing the owner can read back.
    expect(g.requests.filter((r) => r.body.includes(SECRET) && r !== exchange[0])).toHaveLength(0);
    expect(gw.vault.connectorItem(id)).toBeDefined();
    expect(JSON.stringify([c.events, logged, await c.call("connectors.list", {})])).not.toContain(
      SECRET,
    );
  });
});
