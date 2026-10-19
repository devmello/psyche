import { assertNoSecrets, FakeClock, FakeCredentialBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import type {
  ConnectorContext,
  ConnectorRecord,
  FetchFn,
  ToolRunContext,
} from "../../src/framework/types.ts";
import {
  createWebFetchFactory,
  createWebSearchFactory,
  webFetchFactory,
  webSearchFactory,
} from "../../src/web/index.ts";
import { expectPsyche, fakeLookup, fakeTransport, fixture } from "./helpers.ts";

const KEY = "BSAconnectorKey1234567";

function record(type: string, config: ConnectorRecord["config"]): ConnectorRecord {
  return {
    id: "conn_1",
    type,
    label: "x",
    account: null,
    scopes: [],
    scopeMode: "read",
    actionMatrix: {},
    credentialId: null,
    status: "connected",
    config,
    lastSync: null,
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
  };
}

function context(fetch: FetchFn, credentials?: FakeCredentialBroker): ConnectorContext {
  const ctx: ConnectorContext = {
    clock: new FakeClock(),
    fetch,
    tokens: {
      load: async () => undefined,
      save: async () => {},
      clear: async () => {},
    },
    emit: () => {},
  };
  if (credentials !== undefined) ctx.credentials = credentials;
  return ctx;
}

function only<T>(items: T[]): T {
  const [first] = items;
  if (first === undefined) throw new Error("expected one item");
  return first;
}

const run = (approvalId?: string): ToolRunContext => ({
  signal: new AbortController().signal,
  callId: "call_1",
  ...(approvalId === undefined ? {} : { approvalId }),
});

const jsonFetch =
  (body: unknown): FetchFn =>
  async () =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("catalogue entries", () => {
  it("web-search", () => {
    const e = webSearchFactory.entry;
    expect(e).toMatchObject({ id: "web-search", type: "search:brave", auth: "api_key" });
    expect(e.actions).toEqual([
      { id: "search.query", title: "Search the web", sideEffect: "read", defaultRule: "allow" },
    ]);
    expect(createWebSearchFactory({ provider: "searxng" }).entry).toMatchObject({
      type: "search:searxng",
      auth: "none",
    });
  });

  it("web-fetch", () => {
    const e = webFetchFactory.entry;
    expect(e).toMatchObject({ id: "web-fetch", type: "fetch", auth: "none", available: true });
    expect(e.actions).toEqual([
      { id: "fetch.get", title: "Fetch a web page", sideEffect: "read", defaultRule: "allow" },
    ]);
  });
});

describe("web_search tool", () => {
  function brave() {
    const credentials = new FakeCredentialBroker();
    credentials.add({
      slug: "brave",
      kind: "api_key",
      bindings: [{ origin: "https://api.search.brave.com" }],
      secret: KEY,
    });
    credentials.approve("appr-9", { slug: "brave", origin: "https://api.search.brave.com" });
    const connector = webSearchFactory.create(
      record("search:brave", { apiKey: "{{cred:brave}}" }),
      context(jsonFetch(fixture("brave.json")), credentials),
    );
    return { connector, credentials };
  }

  it("exposes one read tool with a JSON schema", () => {
    const tool = only(brave().connector.tools());
    expect(tool).toMatchObject({ name: "web_search", action: "search.query", sideEffect: "read" });
    expect(tool.inputSchema).toMatchObject({ type: "object", required: ["query"] });
    expect(tool.describeCall?.({ query: "cats" })).toEqual({
      sideEffect: "read",
      summary: "Searched the web: cats",
      target: { kind: "origin", value: "https://api.search.brave.com" },
    });
  });

  it("returns untrusted hits and never the key", async () => {
    const { connector } = brave();
    const tool = only(connector.tools());
    const out = await tool.execute({ query: "psyche", count: 2 }, run("appr-9"));
    expect(out.provenance).toBe("untrusted");
    const output = out.output as { provider: string; results: { url: string }[] };
    expect(output.provider).toBe("brave");
    expect(output.results.map((r) => r.url)).toEqual([
      "https://example.org/psyche",
      "https://docs.example.com/agents?ref=brave",
    ]);
    assertNoSecrets(out, "web_search output");
  });

  it("needs an approval to resolve the key", async () => {
    const tool = only(brave().connector.tools());
    await expectPsyche(tool.execute({ query: "q" }, run()), "approval_required");
  });

  it("validates params", async () => {
    const tool = only(brave().connector.tools());
    await expectPsyche(tool.execute({ query: "" }, run("appr-9")), "invalid_params");
    await expectPsyche(tool.execute({ query: "q", count: 0 }, run("appr-9")), "invalid_params");
  });

  it("connect requires a placeholder key; health reports configuration", async () => {
    const { connector } = brave();
    await expectPsyche(
      connector.connect({ scopeMode: "read", config: { apiKey: KEY } }),
      "invalid_params",
    );
    await expect(
      connector.connect({ scopeMode: "read", config: { apiKey: "{{cred:brave}}" } }),
    ).resolves.toEqual({ account: null, scopes: [] });
    expect((await connector.health()).ok).toBe(true);
  });

  it("searxng via config with a custom approveKey never called", async () => {
    let asked = 0;
    const factory = createWebSearchFactory({
      provider: "searxng",
      approveKey: async () => {
        asked += 1;
        return "x";
      },
      lookup: fakeLookup({}),
    });
    const connector = factory.create(
      record("search:searxng", {
        baseUrl: "http://localhost:8888",
        privateAllowlist: ["localhost:8888"],
      }),
      context(jsonFetch(fixture("searxng.json"))),
    );
    expect(connector.type).toBe("search:searxng");
    const tool = only(connector.tools());
    const out = await tool.execute({ query: "q" }, run());
    expect((out.output as { results: unknown[] }).results).toHaveLength(2);
    expect(asked).toBe(0);
  });
});

describe("web_fetch tool", () => {
  const factory = createWebFetchFactory({
    lookup: fakeLookup({ "example.com": "93.184.216.34" }),
    transport: fakeTransport({
      "https://example.com/": { headers: { "content-type": "text/html" }, body: "<h2>Hello</h2>" },
      "https://example.com/missing": {
        status: 404,
        headers: { "content-type": "text/plain" },
        body: "nope",
      },
    }),
  });
  const connector = factory.create(record("fetch", {}), context(jsonFetch({})));
  const tool = only(connector.tools());

  it("exposes one read tool", () => {
    expect(tool).toMatchObject({ name: "web_fetch", action: "fetch.get", sideEffect: "read" });
    expect(tool.inputSchema).toMatchObject({ required: ["url"], additionalProperties: false });
    expect(tool.describeCall?.({ url: "https://example.com/a?b" })).toEqual({
      sideEffect: "read",
      target: { kind: "origin", value: "https://example.com" },
      summary: "Fetched example.com",
    });
    expect(tool.describeCall?.({ url: "nope" })).toEqual({
      sideEffect: "read",
      summary: "Fetch a web page",
    });
  });

  it("returns untrusted Markdown", async () => {
    const out = await tool.execute({ url: "https://example.com/" }, run());
    expect(out.provenance).toBe("untrusted");
    expect(out.isError).toBeUndefined();
    expect(out.output).toMatchObject({
      markdown: "## Hello",
      status: 200,
      provenance: "untrusted",
    });
  });

  it("flags HTTP errors", async () => {
    const out = await tool.execute({ url: "https://example.com/missing" }, run());
    expect(out.isError).toBe(true);
  });

  it("never reaches private hosts (no allowlist on the model-facing tool)", async () => {
    await expectPsyche(
      tool.execute({ url: "http://169.254.169.254/latest/meta-data/" }, run()) ?? Promise.resolve(),
      "policy_denied",
    );
    await expectPsyche(tool.execute({ url: "http://localhost:8888/" }, run()), "policy_denied");
  });

  it("health is ok", async () => {
    expect(await connector.health()).toMatchObject({ ok: true, status: "connected" });
  });
});
