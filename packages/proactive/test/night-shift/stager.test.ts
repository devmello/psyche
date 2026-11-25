import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  callFromItem,
  captureFromItem,
  createAdapters,
  createReadRegistry,
  createStager,
  draftContentHash,
  type ReadRegistry,
} from "../../src/index.ts";
import { FakeRegistry, thread } from "./adapters-registry.ts";
import { draftCall, goodDraft, sqliteStore } from "./rig.ts";

function setup(opts: { domains?: string[]; connectors?: [string, string][] } = {}) {
  const clock = new FakeClock();
  const store = sqliteStore(clock);
  const night = store.insertNight({ night: "2026-11-25", status: "running" });
  const registry = new FakeRegistry();
  registry.threads.set("t-1", thread());
  let captures = 0;
  const counting: ReadRegistry = new Proxy(registry, {
    get(t, k) {
      if (k === "mailThread") captures += 1;
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const connectors = new Map<string, string>(opts.connectors ?? [["google", "google"]]);
  const sink = createStager({
    nightId: night.id,
    store,
    adapters: () => createAdapters(counting, { grants: () => [] }, connectors),
    connectors: () => connectors,
    domains: () => new Set((opts.domains ?? ["mail", "calendar", "reminders", "files"]) as never),
    whyFor: () => "Quiet thread: plan",
  });
  return { sink, store, night, registry, captures: () => captures };
}

describe("the stager always runs the adapter's capture", () => {
  it("refuses a made-up thread id together with a foreign recipient: nothing is stored", async () => {
    const s = setup();
    const r = await s.sink.stage(
      draftCall(s.night.id, { ...goodDraft, threadId: "t-made-up", to: ["eve@evil.com"] }),
    );
    expect(r).toEqual({ staged: false });
    expect(s.captures()).toBe(1);
    expect(s.store.listStagedActions(s.night.id)).toHaveLength(0);
  });

  it("refuses a foreign recipient on a real thread", async () => {
    const s = setup();
    const r = await s.sink.stage(
      draftCall(s.night.id, { ...goodDraft, to: ["ann@x.com", "eve@evil.com"] }),
    );
    expect(r).toEqual({ staged: false });
    expect(s.store.listStagedActions(s.night.id)).toHaveLength(0);
  });

  it("refuses a made-up thread id alone", async () => {
    const s = setup();
    expect(await s.sink.stage(draftCall(s.night.id, { ...goodDraft, threadId: "nope" }))).toEqual({
      staged: false,
    });
  });

  it("refuses when the registry cannot answer (fail closed)", async () => {
    const s = setup();
    s.registry.failing = true;
    expect(await s.sink.stage(draftCall(s.night.id, goodDraft))).toEqual({ staged: false });
    expect(s.store.listStagedActions(s.night.id)).toHaveLength(0);
  });

  it("stages a good draft: capture, preview and send are stored exactly (positive control)", async () => {
    const s = setup();
    const r = await s.sink.stage(draftCall(s.night.id, goodDraft));
    expect(r).toMatchObject({ staged: true });
    expect(s.captures()).toBeGreaterThan(0);
    const [item] = s.store.listStagedActions(s.night.id);
    expect(item).toMatchObject({
      domain: "mail",
      status: "ready",
      targetKey: "t-1",
      tool: "mcp__google__gmail_create_draft",
      why: "Quiet thread: plan",
      taint: true,
    });
    // The wire preview is exactly the adapter's Preview.
    expect(item?.preview).toMatchObject({ kind: "mail", truncated: false });
    expect(item?.preview?.rows.map((x) => x.label)).toEqual(
      expect.arrayContaining(["Thread", "Recipient", "Subject", "Body"]),
    );
    expect(item?.send?.recipients).toEqual(["ann@x.com"]);
    expect(item?.send?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // What W5 needs: the frozen call and the whole capture.
    expect(callFromItem(item as never).args).toEqual(goodDraft);
    expect(captureFromItem(item as never)).toMatchObject({ ok: true, target: "t-1" });
  });

  it("flags a recipient the owner never wrote to", async () => {
    const s = setup();
    s.registry.sentTo.clear();
    await s.sink.stage(draftCall(s.night.id, goodDraft));
    const rows = s.store.listStagedActions(s.night.id)[0]?.preview?.rows ?? [];
    expect(rows.find((x) => x.label === "Recipient")?.badge).toBe("new_recipient");
  });

  it("one live item per target: a later draft on the thread supersedes the earlier", async () => {
    const s = setup();
    await s.sink.stage(draftCall(s.night.id, goodDraft));
    await s.sink.stage(draftCall(s.night.id, { ...goodDraft, body: "Actually, later" }));
    const items = s.store.listStagedActions(s.night.id);
    expect(items.map((i) => i.status)).toEqual(["superseded", "ready"]);
  });
});

describe("the stager refuses what has no adapter", () => {
  it.each([
    ["an MCP server's tool of the same name", "mcp__evil__gmail_create_draft"],
    ["a connector of an unstageable type", "mcp__shop__gmail_create_draft"],
    ["a send", "mcp__google__gmail_send"],
    ["a forward", "mcp__google__mail_forward_draft"],
  ])("%s", async (_l, tool) => {
    const s = setup({
      connectors: [
        ["google", "google"],
        ["evil", "custom"],
        ["shop", "shopping"],
      ],
    });
    const call = { ...draftCall(s.night.id, goodDraft), tool };
    expect(await s.sink.stage(call)).toEqual({ staged: false });
    expect(s.store.listStagedActions(s.night.id)).toHaveLength(0);
  });

  it("a domain the owner turned off", async () => {
    const s = setup({ domains: ["calendar"] });
    expect(await s.sink.stage(draftCall(s.night.id, goodDraft))).toEqual({ staged: false });
  });

  it("another night's call", async () => {
    const s = setup();
    expect(await s.sink.stage(draftCall("night_other", goodDraft))).toEqual({ staged: false });
  });
});

describe("the send hash is W3's one recipe", () => {
  it("equals draftContentHash over to, cc and bcc apart, subject, body, in-reply-to", async () => {
    const s = setup();
    await s.sink.stage(draftCall(s.night.id, { ...goodDraft, cc: ["bob@x.com"] }));
    const item = s.store.listStagedActions(s.night.id)[0];
    const expected = draftContentHash({
      to: ["ann@x.com"],
      cc: ["bob@x.com"],
      bcc: [],
      subject: "Re: plan",
      body: "Sounds good",
      inReplyTo: "t-1",
      attachments: [],
    });
    expect(item?.send?.contentHash).toBe(expected);
  });

  it("changes when a recipient moves from cc to to", async () => {
    const a = setup();
    await a.sink.stage(draftCall(a.night.id, { ...goodDraft, cc: ["bob@x.com"] }));
    const b = setup();
    await b.sink.stage(draftCall(b.night.id, { ...goodDraft, to: ["ann@x.com", "bob@x.com"] }));
    expect(a.store.listStagedActions(a.night.id)[0]?.send?.contentHash).not.toBe(
      b.store.listStagedActions(b.night.id)[0]?.send?.contentHash,
    );
  });
});

describe("the read registry is read-only", () => {
  const tool = (name: string, sideEffect: string, out: unknown, seen: string[]) =>
    [
      name,
      {
        spec: { name, sideEffect },
        execute: async () => {
          seen.push(name);
          return { output: out, isError: false };
        },
      },
    ] as const;

  it("never reaches a tool that is not a pure read", async () => {
    const seen: string[] = [];
    const tools = new Map([tool("gmail_search_threads", "write", [], seen)]);
    const reg = createReadRegistry({ reads: { get: (n) => tools.get(n) as never } });
    await expect(reg.mailSentTo(["ann@x.com"])).rejects.toThrow(/not a read tool/);
    expect(seen).toEqual([]);
  });

  it("on Apple every recipient is new: mail_search is never used for sent history", async () => {
    const seen: string[] = [];
    const tools = new Map([tool("mail_search", "read", [{ id: "1" }], seen)]);
    const reg = createReadRegistry({ reads: { get: (n) => tools.get(n) as never } });
    expect(await reg.mailSentTo(["ann@x.com"])).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("reply-all leaves the owner's own addresses out", async () => {
    const seen: string[] = [];
    const msg = { id: "m1", from: "Ann <ann@x.com>", to: "me@x.com, bob@x.com", replyTo: [] };
    const tools = new Map([tool("mail_read", "read", msg, seen)]);
    const reg = createReadRegistry({
      reads: { get: (n) => tools.get(n) as never },
      ownerAddresses: () => ["ME@x.com"],
    });
    expect(await reg.mailReplyRecipients({ messageId: "m1", replyAll: true })).toEqual([
      "ann@x.com",
      "bob@x.com",
    ]);
  });

  it("refuses a reply whose Reply-To the connector does not report (fail closed), accepts one that does", async () => {
    const seen: string[] = [];
    const msg = { id: "m1", from: "Ann <ann@x.com>", to: "me@x.com", cc: "bob@x.com" };
    const without = new Map([tool("mail_read", "read", msg, seen)]);
    const a = createReadRegistry({ reads: { get: (n) => without.get(n) as never } });
    await expect(a.mailReplyRecipients({ messageId: "m1", replyAll: false })).rejects.toThrow(
      /Reply-To/,
    );
    const withKey = new Map([tool("mail_read", "read", { ...msg, replyTo: [] }, seen)]);
    const b = createReadRegistry({ reads: { get: (n) => withKey.get(n) as never } });
    expect(await b.mailReplyRecipients({ messageId: "m1", replyAll: false })).toEqual([
      "ann@x.com",
    ]);
    expect(await b.mailReplyRecipients({ messageId: "m1", replyAll: true })).toEqual([
      "ann@x.com",
      "me@x.com",
      "bob@x.com",
    ]);
    const redirected = new Map([
      tool("mail_read", "read", { ...msg, replyTo: "Eve <eve@evil.com>" }, seen),
    ]);
    const c = createReadRegistry({ reads: { get: (n) => redirected.get(n) as never } });
    expect(await c.mailReplyRecipients({ messageId: "m1", replyAll: false })).toEqual([
      "eve@evil.com",
    ]);
  });
});
