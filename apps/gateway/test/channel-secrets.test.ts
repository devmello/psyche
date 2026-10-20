import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { channelSecretOwner, vaultChannelSecret } from "../src/compose/channel-secrets.ts";
import { channelsSetupFromEnv, composeChannels } from "../src/compose/channels.ts";
import { type ComposedGateway, composeGateway, vaultModelSetup } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** N8 / N9: channel transport secrets as Gateway-owned vault items (`channels.secrets.*`). */

const BOT = "xoxb-test-0123456789-SECRET";
let home: string;
let composed: ComposedGateway | undefined;
const clients: TestClient[] = [];

async function compose(): Promise<ComposedGateway> {
  const keyFile = join(home, "vault.key");
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  composed = await composeGateway({
    env: { PSYCHE_VAULT_KEY_FILE: keyFile },
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: vaultModelSetup({}),
    vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
    parts: [(s) => composeChannels(s, { healthIntervalMs: 0 })],
  });
  return composed;
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "psyche-channel-secrets-")));
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop();
  composed = undefined;
  await rm(home, { recursive: true, force: true });
});

describe("channels.secrets.*", () => {
  it("stores a Slack token as a Gateway-owned item, reports names only, and reads it per use", async () => {
    const gw = await compose();
    await gw.vault.setup();
    const c = await adminClient(gw.gateway);
    clients.push(c);
    expect(await c.call("channels.secrets.status", { type: "slack", account: "acme" })).toEqual({
      required: ["bot_token", "app_token"],
      set: [],
    });
    const res = await c.call(
      "channels.secrets.set",
      { type: "slack", account: "acme", name: "bot_token", value: BOT },
      ik(),
    );
    expect(res).toEqual({ set: ["bot_token"] });
    expect(JSON.stringify(res)).not.toContain(BOT);
    // Replacing keeps one item; another account is another item.
    await c.call(
      "channels.secrets.set",
      { type: "slack", account: "acme", name: "bot_token", value: `${BOT}-2` },
      ik(),
    );
    const owner = channelSecretOwner("slack", "acme", "bot_token");
    expect((await gw.vault.list()).filter((m) => m.slug === owner)).toHaveLength(1);
    expect(gw.vault.connectorItem(owner)).toMatchObject({ kind: "oauth_token" });

    const seen = await vaultChannelSecret(() => gw.vault, "slack", "acme", "bot_token").use(
      async (v) => v,
    );
    expect(seen).toBe(`${BOT}-2`);
    await expect(
      vaultChannelSecret(() => gw.vault, "slack", "acme", "app_token").use(async (v) => v),
    ).rejects.toMatchObject({ code: "unavailable", details: { reason: "channel_secret_missing" } });

    // A name the type does not use, and a type without secrets, are refused.
    await expect(
      c.call(
        "channels.secrets.set",
        { type: "slack", account: "acme", name: "auth_token", value: "x" },
        ik(),
      ),
    ).rejects.toThrow(/"code":"invalid_params"/);
    await expect(
      c.call(
        "channels.secrets.set",
        { type: "telegram", account: "bot", name: "bot_token", value: "x" },
        ik(),
      ),
    ).rejects.toThrow(/"code":"invalid_params"/);
  });
});

describe("Slack setup from the environment", () => {
  it("is off without a workspace, and takes tokens from env or files (else the vault)", async () => {
    const read = (p: string) => (p === "/run/secrets/slack_app" ? "xapp-file\n" : "");
    expect(channelsSetupFromEnv({}, read).slack).toBeUndefined();
    const vaultOnly = channelsSetupFromEnv({ PSYCHE_SLACK_WORKSPACE: "acme" }, read).slack;
    expect(vaultOnly).toEqual({ account: "acme" });
    const env = channelsSetupFromEnv(
      {
        PSYCHE_SLACK_WORKSPACE: "acme",
        PSYCHE_SLACK_BOT_TOKEN: "xoxb-env",
        PSYCHE_SLACK_APP_TOKEN_FILE: "/run/secrets/slack_app",
      },
      read,
    ).slack;
    expect(await env?.botToken?.use(async (v) => v)).toBe("xoxb-env");
    expect(await env?.appToken?.use(async (v) => v)).toBe("xapp-file");
  });
});
