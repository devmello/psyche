import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProviderSummary } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway, vaultModelSetup } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * #504: a key pasted in Settings → Models must reach Anthropic byte-exact, in `x-api-key`, on
 * the packaged Gateway path (vault-backed keys, no environment), for the probe and for a turn.
 */

const FIXTURES = join(
  import.meta.dirname,
  "../../../packages/model-router/test/fixtures/anthropic",
);
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as {
    response: {
      status: number;
      body?: string;
      chunks?: string[];
      headers?: Record<string, string>;
    };
  };
/** Built at runtime so no secret-looking literal is committed. */
const KEY = ["sk", "ant", "api03", "fx", "A".repeat(20), "B".repeat(20)].join("-");

interface Sent {
  url: string;
  headers: Record<string, string>;
}

let home: string;
let composed: ComposedGateway | undefined;
const clients: TestClient[] = [];
let sent: Sent[] = [];
/** What the fake Anthropic answers: by path. */
let answers: Record<string, string> = {};

const fakeAnthropic = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    headers[k] = v;
  });
  sent.push({ url, headers });
  const path = new URL(url).pathname;
  const fx = fixture(answers[path] ?? "error-401");
  const body = fx.response.body ?? (fx.response.chunks ?? []).join("");
  return new Response(body, {
    status: fx.response.status,
    headers: { "content-type": "application/json", ...fx.response.headers },
  });
}) as typeof fetch;

async function compose(env: Record<string, string> = {}): Promise<ComposedGateway> {
  const keyFile = join(home, "vault.key");
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  composed = await composeGateway({
    env: { PSYCHE_VAULT_KEY_FILE: keyFile, ...env },
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { ...vaultModelSetup({}), fetch: fakeAnthropic },
    vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
  });
  await composed.vault.setup();
  return composed;
}

async function client(gw: ComposedGateway): Promise<TestClient> {
  const c = await adminClient(gw.gateway);
  clients.push(c);
  return c;
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "psyche-key-wire-")));
  sent = [];
  answers = {};
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop();
  composed = undefined;
  await rm(home, { recursive: true, force: true });
});

describe("an Anthropic key from Settings on the wire (#504)", () => {
  it("probes with the exact key in x-api-key and anthropic-version", async () => {
    answers["/v1/models"] = "list-models";
    const c = await client(await compose());
    await c.call("models.setKey", { providerId: "anthropic", key: KEY }, ik());
    const { provider } = await c.call<{ provider: ModelProviderSummary }>("models.probe", {
      providerId: "anthropic",
    });
    expect(provider.probe.state).toBe("reachable");
    const probe = sent.find((s) => new URL(s.url).pathname === "/v1/models");
    expect(probe?.headers["x-api-key"]).toBe(KEY);
    expect(probe?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(probe?.headers.authorization).toBeUndefined();
  });

  it("uses the replacement after the key is entered again", async () => {
    answers["/v1/models"] = "list-models";
    const c = await client(await compose());
    await c.call("models.setKey", { providerId: "anthropic", key: `${KEY}-old` }, ik());
    await c.call("models.setKey", { providerId: "anthropic", key: KEY }, ik());
    await c.call("models.probe", { providerId: "anthropic" });
    expect(sent.at(-1)?.headers["x-api-key"]).toBe(KEY);
  });

  it("sends the exact key on a chat turn with the picked model", async () => {
    answers["/v1/messages"] = "text";
    const c = await client(await compose());
    await c.call("models.setKey", { providerId: "anthropic", key: KEY }, ik());
    await c.call("models.setRole", { role: "primary", ref: "anthropic/claude-haiku-5-5" }, ik());
    const thread = await c.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    await c.call("chat.send", { threadId: thread.thread.id, content: "hi" }, ik());
    await c.waitForEvent(
      (e) =>
        e.event === "run.updated" &&
        ["done", "failed"].includes((e.payload as { run: { status: string } }).run.status),
      15_000,
    );
    const msg = sent.find((s) => new URL(s.url).pathname === "/v1/messages");
    expect(msg?.headers["x-api-key"]).toBe(KEY);
  });

  it.each([
    ["surrounding whitespace and a newline", `  ${KEY}\n`],
    ["quotes", `"${KEY}"`],
    ["a zero-width space and a BOM", `\ufeff${KEY}\u200b`],
    ["a pasted Bearer prefix", `Bearer ${KEY}`],
    ["a pasted header", `x-api-key: ${KEY}`],
  ])("stores the key byte-exact from a paste with %s", async (_what, pasted) => {
    answers["/v1/models"] = "list-models";
    const c = await client(await compose());
    await c.call("models.setKey", { providerId: "anthropic", key: pasted }, ik());
    await c.call("models.probe", { providerId: "anthropic" });
    expect(sent.at(-1)?.headers["x-api-key"]).toBe(KEY);
  });

  it.each([
    [
      "a Claude subscription token",
      KEY.replace("sk-ant-api03", "sk-ant-oat01"),
      "subscription_token",
    ],
    ["an Admin API key", KEY.replace("sk-ant-api03", "sk-ant-admin01"), "admin_key"],
    ["two keys on two lines", `${KEY}\n${KEY}`, "key_whitespace"],
    ["another provider's key", `sk-proj-${"C".repeat(40)}`, "key_shape"],
  ])("refuses %s with a reason, without quoting it", async (_what, pasted, reason) => {
    const c = await client(await compose());
    const res = await c.request("models.setKey", { providerId: "anthropic", key: pasted }, ik());
    expect(res).toMatchObject({
      ok: false,
      error: { code: "invalid_params", details: { reason } },
    });
    expect(JSON.stringify(res)).not.toContain(pasted.split("\n")[0]);
    const list = await c.call<{ providers: ModelProviderSummary[] }>("models.list", {});
    expect(list.providers.find((p) => p.id === "anthropic")?.keyConfigured).toBe(false);
  });

  it("says why Anthropic refused a key", async () => {
    answers["/v1/models"] = "list-models-401";
    const c = await client(await compose());
    await c.call("models.setKey", { providerId: "anthropic", key: KEY }, ik());
    const { provider } = await c.call<{ provider: ModelProviderSummary }>("models.probe", {
      providerId: "anthropic",
    });
    expect(provider.probe).toMatchObject({
      state: "auth_failed",
      error: "the endpoint refused the key (HTTP 401: invalid x-api-key)",
    });
    expect(JSON.stringify(provider)).not.toContain(KEY);
  });
});
