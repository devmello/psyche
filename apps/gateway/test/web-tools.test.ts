import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PinnedRequest, TransportResponse } from "@psyche/connectors";
import type { ModelEvent } from "@psyche/protocol";
import { RateLimiter } from "@psyche/search";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { WebToolsSetup } from "../src/compose/web-tools.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * #557: "what is the current Node.js LTS?" answered through the built-in web.search and
 * web.fetch tools on a Gateway without a browser, against recorded pages (no network).
 */

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const call = (id: string, name: string, input: unknown): ModelEvent[] => [
  { type: "tool_call", id, name, input },
  { type: "usage", usage },
  { type: "finish", reason: "tool_calls" },
];
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason: "stop" },
];

const DDG = `<html lang="en"><body>
<div class="result results_links web-result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fabout%2Fprevious-releases&amp;rut=x">Node.js — Node.js Releases</a></h2>
<a class="result__snippet" href="#">Node.js 24 is the current <b>Active LTS</b>.</a></div>
</body></html>`;
const RELEASES = `<html><head><title>Node.js Releases</title></head><body><main><p>Node.js 24 "Krypton" is Active LTS until October 2026.</p></main></body></html>`;

const encoder = new TextEncoder();
const page = (body: string): TransportResponse => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: (async function* () {
    yield encoder.encode(body);
  })(),
  close() {},
});

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

function network() {
  const searches: string[] = [];
  const pages: PinnedRequest[] = [];
  const setup: WebToolsSetup = {
    fetch: async (input) => {
      searches.push(String(input));
      return new Response(DDG, { headers: { "content-type": "text/html" } });
    },
    limiter: new RateLimiter({ sleep: async () => {} }),
    fetchOptions: {
      lookup: async () => [{ address: "93.184.215.14", family: 4 }],
      transport: async (req) => {
        pages.push(req);
        return page(RELEASES);
      },
    },
  };
  return { setup, searches, pages };
}

async function gateway(
  model: FakeModelProvider,
  web: WebToolsSetup,
  env: Record<string, string> = {},
) {
  home = mkdtempSync(join(tmpdir(), "psyche-web-"));
  composed = await composeGateway({
    env,
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    timeZone: "UTC",
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: model, model: "fake/model" },
    web,
  });
  return composed;
}

/** Sends `content` and approves any card until the agent's final message arrives. */
async function ask(owner: TestClient, threadId: string, content: string, done: string) {
  await owner.call("chat.send", { threadId, content }, ik());
  const answered = new Set<string>();
  const until = Date.now() + 15_000;
  while (
    !owner.events.some(
      (e) => e.event === "chat.message" && JSON.stringify(e.payload).includes(done),
    )
  ) {
    if (Date.now() > until) throw new Error("the turn did not finish");
    const card = owner.events
      .filter((e) => e.event === "approval.created")
      .map((e) => e.payload as { approval: { id: string; kind: string }; answerToken?: string })
      .find((p) => !answered.has(p.approval.id) && p.answerToken !== undefined);
    if (card === undefined) {
      await new Promise((r) => setTimeout(r, 25));
      continue;
    }
    answered.add(card.approval.id);
    await new Promise((r) => setTimeout(r, 450)); // cards arm after 400 ms
    await owner.call("approvals.answer", {
      approvalId: card.approval.id,
      answerToken: card.answerToken,
      decision: "approve",
      scope: "once",
    });
  }
  return [...answered];
}

describe("built-in web.search and web.fetch (#557)", () => {
  it("answers a current-facts question without a browser", async () => {
    const net = network();
    const model = new FakeModelProvider({ capabilities: { contextWindow: 200_000 } });
    model.script([
      () => call("s1", "web.search", { query: "current Node.js LTS version" }),
      () => call("f1", "web.fetch", { url: "https://nodejs.org/en/about/previous-releases" }),
      say("The current Node.js LTS is 24 (Krypton)."),
    ]);
    const gw = await gateway(model, net.setup);
    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    await ask(owner, thread.id, "What is the current Node.js LTS version?", "Node.js LTS is 24");
    await gw.gateway.context.sessions.idle();

    // Both tools were offered to the model and ran against the recorded pages.
    const offered = model.requests[0]?.tools?.map((t) => t.name) ?? [];
    expect(offered).toEqual(expect.arrayContaining(["web.search", "web.fetch"]));
    expect(new URL(net.searches[0] ?? "").origin).toBe("https://html.duckduckgo.com");
    expect(net.pages.map((p) => p.url.toString())).toEqual([
      "https://nodejs.org/en/about/previous-releases",
    ]);
    const toolResults = JSON.stringify(model.requests.at(-1)?.messages ?? []);
    expect(toolResults).toContain("Active LTS");
    expect(toolResults).toContain("Krypton");
    // Search results and page text taint the turn: they are web content.
    const calls = owner.events
      .filter((e) => e.event === "tool_call.updated")
      .map(
        (e) =>
          (e.payload as { toolCall: { tool: string; status: string; provenanceOut: string } })
            .toolCall,
      )
      .filter((c) => c.status === "ok");
    expect(calls.map((c) => [c.tool, c.provenanceOut])).toEqual(
      expect.arrayContaining([
        ["web.search", "untrusted"],
        ["web.fetch", "untrusted"],
      ]),
    );
  });

  it("publishes the provider in effect and follows the owner's settings", async () => {
    const gw = await gateway(new FakeModelProvider(), network().setup, {
      PSYCHE_SEARCH_BRAVE_KEY: "BSA-not-a-real-key",
    });
    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    const status = async () =>
      (
        await owner.call<{ settings: Record<string, unknown> }>("settings.get", {
          keys: ["search.web.status"],
        })
      ).settings["search.web.status"];
    const set = (key: string, value: unknown) => owner.call("settings.set", { key, value }, ik());
    expect(await status()).toEqual({
      preference: "auto",
      active: "brave",
      brave: "env",
      searxngUrl: null,
      note: null,
    });
    await set("search.web.provider", "searxng");
    await set("search.web.searxngUrl", "http://192.168.1.5:8888");
    await new Promise((r) => setTimeout(r, 50));
    expect(await status()).toMatchObject({
      preference: "searxng",
      active: "searxng",
      searxngUrl: "http://192.168.1.5:8888/",
    });
    await set("search.web.provider", "off");
    await new Promise((r) => setTimeout(r, 50));
    expect(await status()).toMatchObject({ active: "off" });
    // The key is never in a setting.
    expect(JSON.stringify(await status())).not.toContain("BSA-not-a-real-key");
  });
});
