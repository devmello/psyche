import { messagesAdapter } from "@psyche/search";
import { afterEach, describe, expect, it } from "vitest";
import { graphSourceAdapters } from "../src/compose/people-sources.ts";
import { appleSearchSeams } from "../src/compose/search-apple.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import {
  desktopClient,
  ik,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

/**
 * Gateway-internal sources (Search's Messages source, the people graph's Messages read, OCR, the
 * Apple on-device model) reach the Host's Mac helper through `NodeRegistry.hostHelper()`, the
 * trusted in-process path. A client's `nodes.invoke` of the same capabilities stays refused on the
 * Host helper: that is an allowlist (R0), because an `operator.write` device must not read
 * Messages or Reminders on the owner's Mac. The two paths are tested side by side here so that
 * fixing one cannot reopen the other.
 */

let t: TestGateway | null = null;
let node: FakeNode | null = null;
let desk: TestClient | null = null;

afterEach(async () => {
  desk?.close();
  await node?.close().catch(() => undefined);
  await t?.cleanup();
  t = null;
  node = null;
  desk = null;
});

const HANDLED = [
  "messages.graph_chats",
  "messages.graph_read",
  "messages.send",
  "ocr.recognize",
  "llm.apple.generate",
  "reminders.list",
  "notes.list",
  "calendar.list_events",
  "mail.search",
];

const read = (name: string, run: FakeNodeHandler["run"]): FakeNodeHandler => ({
  capability: { name, sideEffect: "read", streaming: false },
  run,
});

async function setup(chats?: FakeNodeHandler["run"]) {
  t = await startTestGateway();
  const g = t.gateway;
  const handlers = HANDLED.map((name) => {
    if (name === "messages.graph_chats")
      return read(
        name,
        chats ?? (() => ({ chats: [{ chatId: "c1", handles: ["+15105550101"], isGroup: false }] })),
      );
    if (name === "messages.graph_read")
      return read(name, () => ({
        cursor: 7,
        hasMore: false,
        messages: [
          {
            chatId: "c1",
            handle: "+15105550101",
            sentAt: "2026-11-01T10:00:00Z",
            direction: "in",
            text: "dinner at seven?",
          },
        ],
      }));
    return read(name, () => ({ who: "host" }));
  });
  node = await FakeNode.connect(g.config.nodeSocketPath, {
    origin: g.origin,
    secret: g.handshakeSecret,
    handlers,
  });
  desk = await desktopClient(g);
  return { g, host: node, desk };
}

const seams = (g: TestGateway["gateway"]) =>
  appleSearchSeams({
    connectors: async () => [],
    tools: { get: () => undefined },
    messages: () => g.context.nodes.hostHelper("messages.graph_read")?.client,
    now: () => Date.now(),
  });

const signal = new AbortController().signal;

describe("Gateway-internal sources reach the Host helper", () => {
  it("Search's Messages source reads through hostHelper() with limits the helper serves", async () => {
    const { g, host } = await setup();
    const adapter = messagesAdapter(seams(g).deps);
    expect(adapter.unavailable()).toBeUndefined();
    const page = await adapter.pull(null, { signal, limit: 100 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.text).toContain("dinner at seven?");
    expect(host.invocations.map((i) => i.capability)).toEqual([
      "messages.graph_chats",
      "messages.graph_read",
    ]);
    for (const i of host.invocations)
      expect(Number((i.params as { limit?: number }).limit)).toBeLessThanOrEqual(200);
  });

  it("the people graph's Messages read, OCR and the Apple model reach it the same way", async () => {
    const { g, host } = await setup();
    const adapters = await graphSourceAdapters({
      connectors: async () => [],
      tools: { get: () => undefined },
      clock: { now: () => Date.now() } as never,
      messages: () => g.context.nodes.hostHelper("messages.graph_read")?.client,
    });
    const messages = adapters.find((a) => a.id === "messages:imessage");
    expect(messages).toBeDefined();
    await messages?.pull(null, signal);
    for (const cap of ["ocr.recognize", "llm.apple.generate"]) {
      const res = await g.context.nodes.hostHelper(cap)?.client.invoke(cap, {});
      expect(res, cap).toMatchObject({ ok: true, result: { who: "host" } });
    }
    expect(host.invocations.map((i) => i.capability)).toEqual([
      "messages.graph_chats",
      "messages.graph_read",
      "ocr.recognize",
      "llm.apple.generate",
    ]);
  });

  it("is unavailable, not guessed, while no Host helper is connected", async () => {
    const { g, host } = await setup();
    await host.close();
    await new Promise((r) => setTimeout(r, 50));
    const adapter = messagesAdapter(seams(g).deps);
    expect(adapter.unavailable()).toBe("the Mac helper is not connected");
  });
});

describe("a client's nodes.invoke of the same capabilities stays forbidden", () => {
  it("refuses every Host-bound capability and never reaches the helper", async () => {
    const { host, desk } = await setup();
    for (const capability of HANDLED) {
      const res = await desk.request(
        "nodes.invoke",
        { nodeId: host.nodeId, capability, params: {} },
        ik(),
      );
      expect(res, capability).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect(host.invocations).toEqual([]);
  });
});

describe("what the helper itself refuses", () => {
  it("says which macOS permission is missing instead of a bare 'forbidden'", async () => {
    const { g, host } = await setup(() => {
      throw Object.assign(
        new Error(
          "Psyche (Helper) needs Full Disk Access to read Messages. Turn it on in System Settings › Privacy & Security › Full Disk Access, then try again.",
        ),
        { code: "forbidden", details: { reason: "full_disk_access_missing" } },
      );
    });
    const adapter = messagesAdapter(seams(g).deps);
    await expect(adapter.pull(null, { signal, limit: 100 })).rejects.toThrow(
      /Full Disk Access.*System Settings/,
    );
    expect(host.invocations.every((i) => i.capability === "messages.graph_chats")).toBe(true);
  });
});
