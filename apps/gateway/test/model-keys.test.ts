import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelEvent,
  ModelProvider,
  ModelProviderSummary,
  ModelRequest,
} from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fillableItem } from "../src/compose/exec-tool.ts";
import { type ComposedGateway, composeGateway, vaultModelSetup } from "../src/compose/index.ts";
import {
  hasModelKey,
  modelKeyOwner,
  untilPrimaryPicked,
  vaultModelKeys,
} from "../src/compose/model-keys.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

const KEY = "sk-ant-test-0123456789";
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
  });
  return composed;
}

async function client(gw: ComposedGateway): Promise<TestClient> {
  const c = await adminClient(gw.gateway);
  clients.push(c);
  return c;
}

async function stop() {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop();
  composed = undefined;
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "psyche-model-keys-")));
});

afterEach(async () => {
  await stop();
  await rm(home, { recursive: true, force: true });
});

const anthropic = (providers: ModelProviderSummary[]) =>
  providers.find((p) => p.id === "anthropic");

describe("provider keys in the vault (first run without env)", () => {
  it("stores a key with models.setKey, reports it configured and keeps it across a restart", async () => {
    const gw = await compose();
    await gw.vault.setup();
    const c = await client(gw);
    const before = await c.call<{ providers: ModelProviderSummary[] }>("models.list");
    expect(before.providers.map((p) => p.id)).toEqual([
      "anthropic",
      "openai",
      "google",
      "openrouter",
    ]);
    expect(anthropic(before.providers)?.keyConfigured).toBe(false);

    const res = await c.call<{ provider: ModelProviderSummary }>(
      "models.setKey",
      { providerId: "anthropic", key: KEY },
      ik(),
    );
    expect(res.provider.keyConfigured).toBe(true);
    expect(JSON.stringify(res)).not.toContain(KEY);
    const item = gw.vault.connectorItem(modelKeyOwner("anthropic"));
    expect(item).toMatchObject({
      kind: "oauth_token",
      bindings: [{ connector: "model-anthropic" }, { origin: "https://api.anthropic.com" }],
    });

    // Replacing keeps one item.
    await c.call("models.setKey", { providerId: "anthropic", key: `${KEY}-2` }, ik());
    expect((await gw.vault.list()).filter((m) => m.slug === "model-anthropic")).toHaveLength(1);

    await c.call("models.setRole", { role: "primary", ref: "anthropic/claude-sonnet-5-5" }, ik());
    await stop();
    const again = await compose();
    await again.vault.unlock("test");
    const c2 = await client(again);
    const after = await c2.call<{
      providers: ModelProviderSummary[];
      roles: { primary?: string };
    }>("models.list");
    expect(anthropic(after.providers)?.keyConfigured).toBe(true);
    expect(after.roles.primary).toBe("anthropic/claude-sonnet-5-5");
  });

  it("never offers a provider key to an agent fill", async () => {
    const gw = await compose();
    await gw.vault.setup();
    const c = await client(gw);
    await c.call("models.setKey", { providerId: "anthropic", key: KEY }, ik());
    const items = await gw.vault.list();
    expect(items.some((m) => m.slug === "model-anthropic")).toBe(true);
    expect(fillableItem(items, "model-anthropic")).toBeUndefined();
  });

  it("refuses unknown and keyless providers", async () => {
    const gw = await compose();
    await gw.vault.setup();
    const c = await client(gw);
    await expect(c.call("models.setKey", { providerId: "nope", key: KEY }, ik())).rejects.toThrow(
      /no model provider/,
    );
  });

  it("hands the router the key only for the provider's own origin", async () => {
    const gw = await compose();
    await gw.vault.setup();
    const keys = vaultModelKeys(() => gw.vault);
    const profile = { id: "vault:model-anthropic", credential: "{{cred:model-anthropic}}" };
    const origin = { kind: "origin" as const, value: "https://api.anthropic.com" };
    await expect(keys.resolve(profile, origin)).rejects.toThrow(/no anthropic API key yet/);
    const c = await client(gw);
    await c.call("models.setKey", { providerId: "anthropic", key: KEY }, ik());
    expect(hasModelKey(gw.vault, "anthropic")).toBe(true);
    const secret = await keys.resolve(profile, origin);
    expect(secret?.use((v) => v)).toBe(KEY);
    await expect(
      keys.resolve(profile, { kind: "origin", value: "https://evil.example" }),
    ).rejects.toThrow(/bound to https:\/\/api\.anthropic\.com/);
    expect(keys.redact(`leaked ${KEY}`)).not.toContain(KEY);
    // Locked (boot, idle lock): the first request unlocks through the slot, like a fill.
    gw.vault.lock();
    expect((await keys.resolve(profile, origin))?.use((v) => v)).toBe(KEY);
    expect(gw.vault.locked).toBe(false);
  });
});

describe("untilPrimaryPicked", () => {
  it("answers 'no model configured' until a primary is bound, then delegates", async () => {
    let primary: string | undefined;
    const router = {
      id: "router",
      role: (_r: "primary") => (primary === undefined ? undefined : { model: primary }),
      async *stream(_request: ModelRequest): AsyncIterable<ModelEvent> {
        yield { type: "text_delta", text: "hi from the model" };
        yield { type: "finish", reason: "stop" };
      },
      capabilities: async () => ({
        toolCalling: true,
        vision: false,
        reasoning: false,
        embeddings: false,
      }),
      setThreadModel: () => undefined,
    } satisfies ModelProvider & Record<string, unknown>;
    const wrapped = untilPrimaryPicked(router);
    const text = async () => {
      let out = "";
      for await (const e of wrapped.stream({ model: "router/primary", messages: [] })) {
        if (e.type === "text_delta") out += e.text;
      }
      return out;
    };
    expect(await text()).toMatch(/No model is configured yet/);
    primary = "anthropic/claude-sonnet-5-5";
    expect(await text()).toBe("hi from the model");
    expect(typeof wrapped.setThreadModel).toBe("function");
    expect((await wrapped.capabilities()).toolCalling).toBe(true);
  });
});
