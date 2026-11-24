import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchHit } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { scrubSearchForViewer } from "../src/compose/memory-chunks.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, remoteClient, type TestClient } from "./helpers.ts";

/**
 * Through the real composed Gateway: a paired phone gets no Memory chunk text from
 * `memory.explain`, `memory.search`, `memory.export` or `search.query`; the desktop still does.
 * Fails if `compose/index.ts` stops mounting `mountMemoryHandlers` or `search.query` stops scrubbing.
 */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const SECRET = "Owns a red kayak named Zanzibar";

async function start() {
  home = mkdtempSync(join(tmpdir(), "psyche-memchunks-"));
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  const desktop = await adminClient(composed.gateway);
  const phone = await remoteClient(composed.gateway);
  clients.push(desktop, phone);
  const imported = await desktop.call<{ claims: { id: string }[] }>(
    "memory.import",
    { format: "text", content: SECRET },
    ik(),
  );
  return { gw: composed, desktop, phone, claimId: imported.claims[0]?.id ?? "" };
}

describe("memory chunk text per connection (composed Gateway)", () => {
  it("memory.explain: desktop gets chunks, a phone gets the claim only", async () => {
    const { desktop, phone, claimId } = await start();
    const d = await desktop.call<{ chunks: { text: string }[] }>("memory.explain", { claimId });
    expect(d.chunks.some((c) => c.text.includes("Zanzibar"))).toBe(true);
    const p = await phone.call<{ claim: { id: string }; chunks: unknown[] }>("memory.explain", {
      claimId,
    });
    expect(p.claim.id).toBe(claimId);
    expect(p.chunks).toEqual([]);
    expect(JSON.stringify(p)).not.toContain("lineStart");
  });

  it("memory.search: desktop gets hits, a phone none", async () => {
    const { desktop, phone } = await start();
    const d = await desktop.call<{ hits: unknown[] }>("memory.search", { query: "kayak" });
    expect(d.hits.length).toBeGreaterThan(0);
    expect(await phone.call("memory.search", { query: "kayak" })).toEqual({ hits: [] });
  });

  it("memory.export: refused for a phone, allowed for the desktop", async () => {
    const { desktop, phone } = await start();
    expect((await desktop.call<{ bytes: number }>("memory.export", {})).bytes).toBeGreaterThan(0);
    const res = await phone.request("memory.export", {});
    expect(res.ok).toBe(false);
    expect((res.error as { code: string }).code).toBe("forbidden");
  });

  it("search.query: memory-kind hits and their snippets only for the desktop", async () => {
    const { gw, desktop, phone } = await start();
    await gw.search.idle();
    const q = { query: "kayak", scopes: ["memory"] };
    const d = await desktop.call<{ hits: SearchHit[] }>("search.query", q);
    expect(d.hits.some((h) => h.kind === "memory" && h.snippet.includes("kayak"))).toBe(true);
    const p = await phone.call<{ hits: SearchHit[]; groups?: { group: string }[] }>(
      "search.query",
      q,
    );
    expect(p.hits.filter((h) => h.kind === "memory")).toEqual([]);
    expect((p.groups ?? []).filter((g) => g.group === "memory")).toEqual([]);
    expect(JSON.stringify(p)).not.toContain("Zanzibar");
  });

  it("search.query: Messages, Contacts and Memory-graph hits only for the desktop; mail still shown", async () => {
    const { gw, desktop, phone } = await start();
    const doc = (id: string, source: string, title: string, text: string) => ({
      id,
      kind: "connector" as const,
      title,
      text,
      provenance: "owner" as const,
      tags: [source],
      source,
      scopeKey: "owner",
      createdAt: Date.now(),
    });
    for (const d of [
      doc("messages:42", "messages", "Mum", "Mum: the door code is 4417 plumbago"),
      doc("contacts:9", "contacts", "Plumbago Pat", "Plumbago Pat, plumbago street"),
      doc("memory:m1", "memory", "Plumbago graph", "plumbago node note"),
      doc("mail:7", "mail", "Plumbago invoice", "the plumbago invoice is attached"),
    ])
      await gw.search.index.index(d as never);
    const q = { query: "plumbago" };
    type Res = {
      hits: SearchHit[];
      groups?: { count: number; hits: SearchHit[] }[];
      total: number;
    };
    const d = await desktop.call<Res>("search.query", q);
    const dIds = d.hits.map((h) => h.id);
    expect(dIds).toEqual(expect.arrayContaining(["messages:42", "contacts:9", "mail:7"]));
    const p = await phone.call<Res>("search.query", q);
    const all = [...p.hits, ...(p.groups ?? []).flatMap((g) => g.hits)];
    expect(all.map((h) => h.id)).toContain("mail:7");
    expect(all.filter((h) => /^(messages|contacts|memory):/.test(h.id))).toEqual([]);
    const text = JSON.stringify(p);
    for (const leak of ["4417", "Mum", "Plumbago Pat", "plumbago graph", "plumbago node"])
      expect(text.toLowerCase()).not.toContain(leak.toLowerCase());
    expect(p.total).toBe(1);
    expect(d.total).toBeGreaterThan(p.total);
    expect((p.groups ?? []).reduce((n, g) => n + g.count, 0)).toBe(1);
  });
});

describe("scrubSearchForViewer (second pass over a search response)", () => {
  const hit = (id: string) => ({ id, kind: "connector", group: "other" });
  const res = () => ({
    hits: [hit("messages:1"), hit("mail:2")],
    groups: [
      { group: "other", count: 5, hits: [hit("messages:1"), hit("contacts:3"), hit("mail:2")] },
    ],
    total: 5,
  });
  const call = (desktopShell: boolean) => ({ identity: { role: "client", desktopShell } }) as never;

  it("drops refused hits everywhere and subtracts them from total and counts", () => {
    const out = scrubSearchForViewer(call(false), res());
    expect(out.hits.map((h) => h.id)).toEqual(["mail:2"]);
    expect(out.groups[0]?.hits.map((h) => h.id)).toEqual(["mail:2"]);
    expect(out.groups[0]?.count).toBe(3);
    expect(out.total).toBe(3);
  });

  it("leaves the desktop's response whole", () => {
    expect(scrubSearchForViewer(call(true), res())).toEqual(res());
  });
});
