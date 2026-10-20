import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, openDb, setSetting, updateDevice } from "@psyche/db";
import type { ModelProviderSummary, ModelRoles } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway, type ModelSetup } from "../src/compose/index.ts";
import { modelSetupFromEnv } from "../src/compose/models.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/** Recorded listing answers for the local servers (no network, no model process). */
const LISTINGS: Record<string, unknown> = {
  "http://127.0.0.1:1234/api/v1/models": {
    models: [
      {
        type: "llm",
        key: "qwen/qwen3.8-27b",
        display_name: "Qwen3.8 27B",
        loaded_instances: [{ id: "qwen/qwen3.8-27b", config: { context_length: 32768 } }],
        max_context_length: 262144,
        capabilities: { vision: false, trained_for_tool_use: true },
      },
      {
        type: "llm",
        key: "google/gemma-4-12b",
        loaded_instances: [],
        max_context_length: 131072,
        capabilities: { vision: true, trained_for_tool_use: true },
      },
    ],
  },
};

const requested: string[] = [];
const fixtureFetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  requested.push(url);
  const body = LISTINGS[url];
  if (body === undefined) throw new TypeError("fetch failed: connect ECONNREFUSED");
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const ROUTER: ModelSetup = {
  router: {
    providers: [
      { id: "lmstudio", kind: "lmstudio" },
      { id: "llamacpp", kind: "llamacpp", baseURL: "http://127.0.0.1:8081/v1" },
    ],
    roles: {
      primary: { model: "lmstudio/qwen/qwen3.8-27b", fallbacks: ["llamacpp/qwen3-8b"] },
    },
  },
  fetch: fixtureFetch,
};

let home: string;
let composed: ComposedGateway | undefined;
const clients: TestClient[] = [];

async function compose(model: ModelSetup = ROUTER): Promise<ComposedGateway> {
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model,
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
  home = await realpath(await mkdtemp(join(tmpdir(), "psyche-models-")));
  requested.length = 0;
});

afterEach(async () => {
  await stop();
  await rm(home, { recursive: true, force: true });
});

const byId = (providers: ModelProviderSummary[], id: string) => providers.find((p) => p.id === id);

describe("models.* (Settings → Model & providers)", () => {
  it("lists configured providers as not_probed and never probes on its own", async () => {
    const desk = await client(await compose());
    const res = await desk.call<{ providers: ModelProviderSummary[]; roles: ModelRoles }>(
      "models.list",
      {},
    );
    expect(res.roles).toEqual({ primary: "lmstudio/qwen/qwen3.8-27b" });
    expect(res.providers.map((p) => p.id)).toEqual(["lmstudio", "llamacpp"]);
    expect(byId(res.providers, "lmstudio")).toMatchObject({
      kind: "lmstudio",
      label: "LM Studio",
      baseURL: "http://127.0.0.1:1234/v1",
      local: true,
      keyConfigured: false,
      probe: { state: "not_probed", models: [] },
      models: [{ ref: "lmstudio/qwen/qwen3.8-27b", toolCheck: "untested" }],
    });
    expect(requested).toEqual([]);
  });

  it("probes one provider on request, stores the result and lists its models", async () => {
    const gw = await compose();
    const desk = await client(gw);
    const { provider } = await desk.call<{ provider: ModelProviderSummary }>("models.probe", {
      providerId: "lmstudio",
    });
    expect(provider.probe).toMatchObject({ state: "reachable", server: "LM Studio" });
    expect(provider.models.map((m) => m.ref)).toEqual([
      "lmstudio/qwen/qwen3.8-27b",
      "lmstudio/google/gemma-4-12b",
    ]);
    expect(provider.models[1]?.capabilities).toMatchObject({ vision: true, toolCalling: true });
    expect(getSetting(gw.db, "models.endpoint.lmstudio")?.value).toMatchObject({
      state: "reachable",
    });
    // The router learned the listing's facts.
    expect(await gw.provider.capabilities("lmstudio/google/gemma-4-12b")).toMatchObject({
      vision: true,
      contextWindow: 131072,
    });

    const down = await desk.call<{ provider: ModelProviderSummary }>("models.probe", {
      providerId: "llamacpp",
    });
    expect(down.provider.probe).toMatchObject({ state: "unreachable", models: [] });
    await expect(desk.call("models.probe", { providerId: "nope" })).rejects.toThrow(
      /"code":"not_found"/,
    );
  });

  it("binds and persists a utility pick, and restores it at boot", async () => {
    let desk = await client(await compose());
    const res = await desk.call<{ roles: ModelRoles }>(
      "models.setRole",
      { role: "utility", ref: "lmstudio/google/gemma-4-12b" },
      ik(),
    );
    expect(res.roles).toEqual({
      primary: "lmstudio/qwen/qwen3.8-27b",
      utility: "lmstudio/google/gemma-4-12b",
    });
    await expect(
      desk.call("models.setRole", { role: "primary", ref: "openai/gpt-5.5" }, ik()),
    ).rejects.toThrow(/"code":"not_found"/);
    await stop();

    desk = await client(await compose());
    const after = await desk.call<{ roles: ModelRoles }>("models.list", {});
    expect(after.roles.utility).toBe("lmstudio/google/gemma-4-12b");
  });

  it("refuses a chat-only primary unless overridden (B4)", async () => {
    const db = openDb(join(home, "psyche.db"));
    setSetting(db, "models.probe.llamacpp/tiny", {
      ref: "llamacpp/tiny",
      status: "chat-only",
      passed: 2,
      total: 6,
      inconclusive: false,
      cases: [],
      probedAt: "2026-10-19T20:00:00Z",
    });
    db.close();
    const desk = await client(await compose());
    const list = await desk.call<{ providers: ModelProviderSummary[] }>("models.list", {});
    expect(byId(list.providers, "llamacpp")?.models).toEqual([
      { ref: "llamacpp/qwen3-8b", toolCheck: "untested" },
    ]);
    await expect(
      desk.call("models.setRole", { role: "primary", ref: "llamacpp/tiny" }, ik()),
    ).rejects.toThrow(/"code":"policy_denied"/);
    const ok = await desk.call<{ roles: ModelRoles }>(
      "models.setRole",
      { role: "primary", ref: "llamacpp/tiny", override: true },
      ik(),
    );
    expect(ok.roles.primary).toBe("llamacpp/tiny");
  });

  it("needs operator.admin to probe or pick", async () => {
    const gw = await compose();
    const key = newDeviceKey();
    (await desktopClient(gw.gateway, key, "reader")).close();
    updateDevice(gw.db, "reader", { scopes: ["operator.read"] });
    const reader = await desktopClient(gw.gateway, key, "reader");
    clients.push(reader);
    await expect(reader.call("models.list", {})).resolves.toBeDefined();
    await expect(reader.call("models.probe", { providerId: "lmstudio" })).rejects.toThrow(
      /"code":"forbidden"/,
    );
    await expect(
      reader.call("models.setRole", { role: "utility", ref: "lmstudio/x" }, ik()),
    ).rejects.toThrow(/"code":"forbidden"/);
    expect(requested).toEqual([]);
  });

  it("reports a fixed provider without providers, and refuses role picks", async () => {
    const desk = await client(
      await compose({ provider: new FakeModelProvider(), model: "fake/model" }),
    );
    expect(await desk.call("models.list", {})).toEqual({
      providers: [],
      roles: { primary: "fake/model" },
    });
    await expect(
      desk.call("models.setRole", { role: "utility", ref: "fake/model" }, ik()),
    ).rejects.toThrow(/"code":"unavailable"/);
  });
});

describe("modelSetupFromEnv local endpoints", () => {
  it("lists local servers whose URL is set and supports them as PSYCHE_MODEL", () => {
    const setup = modelSetupFromEnv({
      PSYCHE_MODEL: "lmstudio/qwen/qwen3.8-27b",
      PSYCHE_LMSTUDIO_URL: "http://10.0.0.5:1234/v1",
      PSYCHE_LLAMACPP_URL: "http://127.0.0.1:8080/v1",
    });
    expect(setup && "router" in setup ? setup.router.providers : []).toEqual([
      { id: "lmstudio", kind: "lmstudio", baseURL: "http://10.0.0.5:1234/v1" },
      { id: "llamacpp", kind: "llamacpp", baseURL: "http://127.0.0.1:8080/v1" },
      { id: "claude-code", kind: "claude-code" },
      { id: "codex", kind: "codex" },
    ]);
  });

  it("supports the subscription CLIs as PSYCHE_MODEL and lets them be left out", () => {
    const setup = modelSetupFromEnv({
      PSYCHE_MODEL: "claude-code/sonnet",
      PSYCHE_CLAUDE_PATH: "/opt/claude/bin/claude",
    });
    expect(setup && "router" in setup ? setup.router : undefined).toMatchObject({
      providers: [
        { id: "claude-code", kind: "claude-code", command: "/opt/claude/bin/claude" },
        { id: "codex", kind: "codex" },
      ],
      roles: { primary: { model: "claude-code/sonnet" } },
    });
    const off = modelSetupFromEnv({
      PSYCHE_MODEL: "ollama/qwen3.8:27b",
      PSYCHE_SUBSCRIPTION_CLIS: "off",
    });
    expect(off && "router" in off ? off.router.providers.map((p) => p.id) : []).toEqual(["ollama"]);
  });
});

describe("subscription CLIs in Settings (fake CLI)", () => {
  const FAKE = join(
    import.meta.dirname,
    "../../../packages/model-router/test/fake-cli/fake-cli.mjs",
  );

  it("lists Claude Code and Codex, probes them on request and binds one as primary", async () => {
    const env = {
      ...process.env,
      FAKE_CLI_AUTH: JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "owner@example.com",
        subscriptionType: "pro",
      }),
      FAKE_CLI_VERSION: "2.1.286 (Claude Code)",
    };
    const desk = await client(
      await compose({
        router: {
          providers: [
            { id: "claude-code", kind: "claude-code", command: FAKE },
            { id: "codex", kind: "codex", command: join(home, "no-codex-here") },
          ],
        },
        cli: { env },
      }),
    );
    const list = await desk.call<{ providers: ModelProviderSummary[] }>("models.list", {});
    expect(
      list.providers.map((p) => [p.id, p.label, p.local, p.keyConfigured, p.probe.state]),
    ).toEqual([
      ["claude-code", "Claude Code (subscription)", false, false, "not_probed"],
      ["codex", "ChatGPT via Codex (subscription)", false, false, "not_probed"],
    ]);
    const claude = await desk.call<{ provider: ModelProviderSummary }>("models.probe", {
      providerId: "claude-code",
    });
    expect(claude.provider.probe).toMatchObject({
      state: "reachable",
      server: `Claude Code 2.1.286 · ${FAKE} (claude.ai, pro plan)`,
    });
    expect(claude.provider.models.map((m) => m.ref)).toContain("claude-code/sonnet");
    expect(JSON.stringify(claude)).not.toContain("owner@example.com");
    const codex = await desk.call<{ provider: ModelProviderSummary }>("models.probe", {
      providerId: "codex",
    });
    expect(codex.provider.probe).toMatchObject({ state: "unreachable" });
    expect(codex.provider.probe.error).toContain("not installed");
    const picked = await desk.call<{ roles: ModelRoles }>(
      "models.setRole",
      { role: "primary", ref: "claude-code/sonnet" },
      ik(),
    );
    expect(picked.roles.primary).toBe("claude-code/sonnet");
  });
});
