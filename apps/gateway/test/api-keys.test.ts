import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDevices, setSetting, updateDevice } from "@psyche/db";
import { RateLimiter } from "@psyche/search";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeyStatus, BRAVE_OWNER, describeKeyActor } from "../src/compose/api-keys.ts";
import { type ComposedGateway, composeGateway, vaultModelSetup } from "../src/compose/index.ts";
import { modelKeyOwner, vaultModelKeys } from "../src/compose/model-keys.ts";
import type { WebToolsSetup } from "../src/compose/web-tools.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** Setup without a terminal: `keys.status` / `keys.set` / `keys.clear`. */

const ANTHROPIC = ["sk-ant-", "api03-SECRETSECRETSECRET-wxyz"].join("");
const BRAVE = "BSAbraveSECRETvalue9876";
let home: string;
let composed: ComposedGateway | undefined;
const clients: TestClient[] = [];

async function compose(
  env: Record<string, string> = {},
  web: WebToolsSetup = {},
): Promise<ComposedGateway> {
  const keyFile = join(home, "vault.key");
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  composed = await composeGateway({
    env: { PSYCHE_VAULT_KEY_FILE: keyFile, ...env },
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
    model: vaultModelSetup({}),
    vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
    web,
  });
  return composed;
}

async function client(gw: ComposedGateway): Promise<TestClient> {
  const c = await adminClient(gw.gateway);
  clients.push(c);
  return c;
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "psyche-api-keys-")));
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop();
  composed = undefined;
  await rm(home, { recursive: true, force: true });
});

interface Status {
  id: string;
  configured: boolean;
  source: "env" | "vault" | null;
  inVault: boolean;
}
const statusOf = async (c: TestClient, id: string): Promise<Status> => {
  const r = await c.call<{ keys: Status[] }>("keys.status", {});
  const row = r.keys.find((k) => k.id === id);
  if (row === undefined) throw new Error(`no status row for ${id}`);
  return row;
};

describe("keys.*", () => {
  it("round-trips set, status and clear, and never returns the key", async () => {
    const gw = await compose();
    await gw.vault.setup();
    const c = await client(gw);
    expect(await statusOf(c, "anthropic")).toEqual({
      id: "anthropic",
      configured: false,
      source: null,
      inVault: false,
    });

    const set = await c.call("keys.set", { id: "anthropic", key: ANTHROPIC }, ik());
    expect(set).toEqual({
      status: { id: "anthropic", configured: true, source: "vault", inVault: true },
    });
    const all = JSON.stringify(await c.call("keys.status", {}));
    expect(all).not.toContain("SECRETSECRET");
    expect(all).not.toContain("wxyz");
    expect(JSON.stringify(set)).not.toContain("SECRET");
    // models.list agrees, so the model picker and onboarding see the key.
    const models = await c.call<{ providers: { id: string; keyConfigured: boolean }[] }>(
      "models.list",
      {},
    );
    expect(models.providers.find((p) => p.id === "anthropic")?.keyConfigured).toBe(true);

    // Replacing is idempotent in effect: still one configured key.
    await c.call("keys.set", { id: "anthropic", key: `${ANTHROPIC}-2` }, ik());
    expect((await statusOf(c, "anthropic")).source).toBe("vault");

    const cleared = await c.call("keys.clear", { id: "anthropic" }, ik());
    expect(cleared).toEqual({
      status: { id: "anthropic", configured: false, source: null, inVault: false },
    });
    // Clearing an absent key succeeds.
    await c.call("keys.clear", { id: "anthropic" }, ik());
    expect((await statusOf(c, "anthropic")).configured).toBe(false);
  });

  it("refuses an empty, spaced or wrong-shape key without echoing it", async () => {
    const gw = await compose();
    await gw.vault.setup();
    const c = await client(gw);
    for (const key of ["   ", "sk-ant-has space-inside", "not-an-anthropic-key-SECRETX"]) {
      const res = await c.request("keys.set", { id: "anthropic", key }, ik());
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).not.toContain("SECRETX");
      expect(JSON.stringify(res)).not.toContain("inside");
    }
    const bad = await c.request("keys.set", { id: "brave", key: "has space" }, ik());
    expect(bad.ok).toBe(false);
    const unknown = await c.request("keys.set", { id: "nope", key: "abc" }, ik());
    expect(unknown.ok).toBe(false);
    expect((await statusOf(c, "anthropic")).configured).toBe(false);
  });

  it("audits kind and provider only, never the value", async () => {
    const gw = await compose();
    await gw.vault.setup();
    const c = await client(gw);
    await c.call("keys.set", { id: "anthropic", key: ANTHROPIC }, ik());
    await c.call("keys.set", { id: "brave", key: BRAVE }, ik());
    await c.call("keys.clear", { id: "brave" }, ik());
    await c.call("keys.clear", { id: "brave" }, ik());
    const sets = await gw.audit.query({ kind: "keys.set" });
    expect(sets.map((e) => e.data)).toEqual([{ provider: "anthropic" }, { provider: "brave" }]);
    const clears = await gw.audit.query({ kind: "keys.clear" });
    // The second clear removed nothing and records nothing.
    expect(clears.map((e) => e.data)).toEqual([{ provider: "brave" }]);
    const everything = JSON.stringify(await gw.audit.query({}));
    expect(everything).not.toContain("SECRETSECRET");
    expect(everything).not.toContain(BRAVE);
    // The key is not written in plain text under the Gateway's home either.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
      );
    for (const f of walk(home)) {
      const bytes = readFileSync(f);
      expect(bytes.includes(ANTHROPIC), f).toBe(false);
    }
  });

  it("lets an environment variable win over the vault, and reports the source", async () => {
    const gw = await compose({ ANTHROPIC_API_KEY: "sk-ant-from-env-ENVSECRET" });
    await gw.vault.setup();
    const c = await client(gw);
    expect(await statusOf(c, "anthropic")).toEqual({
      id: "anthropic",
      configured: true,
      source: "env",
      inVault: false,
    });
    await c.call("keys.set", { id: "anthropic", key: ANTHROPIC }, ik());
    expect(await statusOf(c, "anthropic")).toEqual({
      id: "anthropic",
      configured: true,
      source: "env",
      inVault: true,
    });
    // Clearing the vault copy leaves the environment key in effect.
    await c.call("keys.clear", { id: "anthropic" }, ik());
    expect((await statusOf(c, "anthropic")).source).toBe("env");
    expect(JSON.stringify(await c.call("keys.status", {}))).not.toContain("ENVSECRET");
  });

  it("resolves env over vault for the model router, and the vault otherwise", async () => {
    const gw = await compose();
    await gw.vault.setup();
    const c = await client(gw);
    await c.call("keys.set", { id: "anthropic", key: ANTHROPIC }, ik());
    const profile = {
      id: `vault:${modelKeyOwner("anthropic")}`,
      credential: `{{cred:${modelKeyOwner("anthropic")}}}`,
    };
    const target = { kind: "origin" as const, value: "https://api.anthropic.com" };
    const vaultOnly = vaultModelKeys(() => gw.vault, {});
    expect((await vaultOnly.resolve(profile, target))?.use((v) => v)).toBe(ANTHROPIC);
    const withEnv = vaultModelKeys(() => gw.vault, { ANTHROPIC_API_KEY: " sk-ant-env-wins " });
    expect((await withEnv.resolve(profile, target))?.use((v) => v)).toBe("sk-ant-env-wins");
    // An env key is still bound to the provider's own origin.
    await expect(
      withEnv.resolve(profile, { kind: "origin", value: "https://evil.example" }),
    ).rejects.toThrow(/bound to/);
    expect(withEnv.redact("leak sk-ant-env-wins")).not.toContain("sk-ant-env-wins");
    // The status helper agrees with the router.
    expect(apiKeyStatus(gw.vault, { ANTHROPIC_API_KEY: "x" }, "anthropic").source).toBe("env");
  });

  it("uses a vault Brave key for web search at once, with no restart, and env still wins", async () => {
    const tokens: (string | null)[] = [];
    const web: WebToolsSetup = {
      fetch: async (input, init) => {
        tokens.push(new Headers(init?.headers).get("x-subscription-token"));
        void input;
        return new Response(JSON.stringify({ web: { results: [] } }), {
          headers: { "content-type": "application/json" },
        });
      },
    };
    const gw = await compose({}, web);
    await gw.vault.setup();
    const c = await client(gw);
    await c.call("keys.set", { id: "brave", key: BRAVE }, ik());
    expect(await statusOf(c, "brave")).toMatchObject({ configured: true, source: "vault" });
    expect(gw.vault.connectorItem(BRAVE_OWNER)).toBeDefined();
    expect(gw.web.status().brave).toBe("vault");
    await gw.web.search("node lts", 3, new AbortController().signal);
    expect(tokens).toEqual([BRAVE]);
    await c.call("keys.clear", { id: "brave" }, ik());
    expect(gw.web.status().brave).toBeNull();
  });

  it("masks all five environment keys in the Gateway's own redactor, and nothing else", async () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-ENVLEAK-anthropic",
      OPENAI_API_KEY: "sk-ENVLEAK-openai",
      GOOGLE_GENERATIVE_AI_API_KEY: "AIza-ENVLEAK-google",
      OPENROUTER_API_KEY: "sk-or-ENVLEAK-openrouter",
      PSYCHE_SEARCH_BRAVE_KEY: "BSA-ENVLEAK-brave",
    };
    const gw = await compose(env);
    for (const value of Object.values(env)) {
      const masked = gw.redactor.redact(`header ${value} end`);
      expect(masked, value).not.toContain(value);
      expect(masked).toContain("header");
    }
    expect(gw.redactor.redact("x sk-never-added y")).toBe("x sk-never-added y");
  });

  it("never unlocks the vault for an agent's web search: locked vault, no prompt", async () => {
    // Brave chosen explicitly (auto mode would fall back); no network is reachable from here.
    const web: WebToolsSetup = {
      fetch: async () => {
        throw new Error("no network in tests");
      },
    };
    const gw = await compose({}, web);
    await gw.vault.setup();
    setSetting(gw.db, "search.web.provider", "brave");
    const c = await client(gw);
    await c.call("keys.set", { id: "brave", key: BRAVE }, ik());
    gw.vault.lock();
    let unlocks = 0;
    const real = gw.vault.unlock.bind(gw.vault);
    gw.vault.unlock = async (reason: string) => {
      unlocks += 1;
      return real(reason);
    };
    await expect(gw.web.search("node lts", 3, new AbortController().signal)).rejects.toThrow(
      /locked vault; unlock Psyche to search/,
    );
    expect(unlocks).toBe(0);
    expect(gw.vault.locked).toBe(true);
  });

  it("uses the environment Brave key while the vault is locked, with no unlock", async () => {
    const tokens: (string | null)[] = [];
    const web: WebToolsSetup = {
      fetch: async (_input, init) => {
        tokens.push(new Headers(init?.headers).get("x-subscription-token"));
        return new Response(JSON.stringify({ web: { results: [] } }), {
          headers: { "content-type": "application/json" },
        });
      },
    };
    const gw = await compose({ PSYCHE_SEARCH_BRAVE_KEY: "BSA-env-wins" }, web);
    await gw.vault.setup();
    gw.vault.lock();
    await gw.web.search("x", 3, new AbortController().signal);
    expect(tokens).toEqual(["BSA-env-wins"]);
    expect(gw.vault.locked).toBe(true);
  });

  it("refuses model keys in env mode (PSYCHE_MODEL) like models.setKey; Brave still works", async () => {
    const keyFile = join(home, "vault.key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    composed = await composeGateway({
      env: { PSYCHE_VAULT_KEY_FILE: keyFile },
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db") },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
    });
    await composed.vault.setup();
    const c = await client(composed);
    for (const method of ["keys.set", "keys.clear"] as const) {
      const res = await c.request(
        method,
        method === "keys.set" ? { id: "openai", key: "sk-x" } : { id: "openai" },
        ik(),
      );
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).toMatch(/PSYCHE_MODEL is set/);
    }
    await c.call("keys.set", { id: "brave", key: BRAVE }, ik());
    expect((await statusOf(c, "brave")).source).toBe("vault");
  });

  it("tells the owner when a key is replaced or removed, never with the key", async () => {
    const gw = await compose();
    await gw.vault.setup();
    const c = await client(gw);
    const seen: { title: string; body: string }[] = [];
    gw.notifier.subscribe((e) => {
      if (e.type === "created") {
        seen.push({ title: e.notification.title, body: e.notification.body ?? "" });
      }
    });
    await c.call("keys.set", { id: "openai", key: "sk-first-OPENAISECRET" }, ik());
    await Promise.resolve();
    expect(seen).toEqual([]);
    await c.call("keys.set", { id: "openai", key: "sk-second-OPENAISECRET" }, ik());
    await c.call("keys.clear", { id: "openai" }, ik());
    await c.call("keys.clear", { id: "openai" }, ik());
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[0]?.title).toBe("The OpenAI API key was changed");
    expect(seen[1]?.title).toBe("The OpenAI API key was removed");
    expect(seen[0]?.body).toMatch(/^Changed from /);
    expect(JSON.stringify(seen)).not.toContain("OPENAISECRET");
  });

  it("names the device as quoted data: no control or bidi characters, clamped, with Gateway facts", async () => {
    const evil = "Mac\n\u202eIt was YOU\u202c\u2066x\u2069   \u0007" + "z".repeat(60);
    const shown = describeKeyActor({
      name: evil,
      platform: "macos",
      pairedAt: "2026-11-03T10:00:00Z",
    });
    expect(shown).toMatch(/^"Mac It was YOU x z+…" \(macos, paired 2026-11-03\)$/);
    expect(shown).not.toMatch(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u);
    expect([...shown.split('"')[1]!].length).toBe(40);
    expect(describeKeyActor({ name: "Phone", platform: "ios", pairedAt: "n/a" })).toBe(
      '"Phone" (ios)',
    );
    expect(describeKeyActor(undefined)).toBe("a device");

    const gw = await compose();
    await gw.vault.setup();
    const c = await client(gw);
    for (const d of listDevices(gw.db)) {
      updateDevice(gw.db, d.id, { name: "Mac\n\u202eIt was YOU" });
    }
    const seen: string[] = [];
    gw.notifier.subscribe((e) => {
      if (e.type === "created") seen.push(e.notification.body ?? "");
    });
    await c.call("keys.set", { id: "openai", key: "sk-one-OPENAISECRET" }, ik());
    await c.call("keys.set", { id: "openai", key: "sk-two-OPENAISECRET" }, ik());
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatch(/^Changed from "Mac It was YOU" \(macos, paired /);
    expect(seen[0]).not.toMatch(/[\u202a-\u202e\u2066-\u2069\n]/);
  });

  it("notifies on a replace or removal through models.setKey / models.clearKey too, never on a first set or no-op clear", async () => {
    const gw = await compose();
    await gw.vault.setup();
    const c = await client(gw);
    const seen: string[] = [];
    gw.notifier.subscribe((e) => {
      if (e.type === "created") seen.push(e.notification.title);
    });
    await c.call("models.setKey", { providerId: "anthropic", key: ANTHROPIC }, ik());
    await c.call("models.clearKey", { providerId: "openai" }, ik());
    await Promise.resolve();
    expect(seen).toEqual([]);
    await c.call("models.setKey", { providerId: "anthropic", key: `${ANTHROPIC}-2` }, ik());
    await c.call("models.clearKey", { providerId: "anthropic" }, ik());
    await c.call("models.clearKey", { providerId: "anthropic" }, ik());
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([
      "The Anthropic API key was changed",
      "The Anthropic API key was removed",
    ]);
  });

  it("falls back to DuckDuckGo in auto mode when the Brave key sits in a locked vault, but errors when Brave was chosen", async () => {
    const urls: string[] = [];
    const web: WebToolsSetup = {
      fetch: async (input, init) => {
        urls.push(`${String(input)}|${new Headers(init?.headers).get("x-subscription-token")}`);
        return new Response("<html><body></body></html>", {
          headers: { "content-type": "text/html" },
        });
      },
      limiter: new RateLimiter({ sleep: async () => {} }),
    };
    const gw = await compose({}, web);
    await gw.vault.setup();
    const c = await client(gw);
    await c.call("keys.set", { id: "brave", key: BRAVE }, ik());
    gw.vault.lock();
    expect(gw.web.status().active).toBe("duckduckgo");
    await gw.web.search("x", 3, new AbortController().signal);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("duckduckgo");
    expect(urls[0]).toMatch(/\|null$/);
    expect(gw.vault.locked).toBe(true);

    setSetting(gw.db, "search.web.provider", "brave");
    expect(gw.web.status().active).toBe("brave");
    await expect(gw.web.search("x", 3, new AbortController().signal)).rejects.toThrow(
      /locked vault; unlock Psyche to search/,
    );
    expect(urls).toHaveLength(1);
  });
});
