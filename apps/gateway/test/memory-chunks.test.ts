import type { MemoryHandlers } from "@psyche/memory";
import { PsycheError } from "@psyche/protocol";
import { describe, expect, it, vi } from "vitest";
import { mountMemoryHandlers } from "../src/compose/memory-chunks.ts";
import type { Call } from "../src/context.ts";

/**
 * `memory.search` / `memory.explain` hand out Memory chunk text. Memory is owner-only: a paired
 * phone or remote client gets none of it (the `memory.life.answer` / `search.document` rule),
 * the desktop app and the Host CLI keep today's result.
 */

const call = (identity: Partial<Call["identity"]>): Call => ({ identity }) as unknown as Call;
const desktop = call({ role: "client", desktopShell: true });
const hostCli = call({ role: "client", localHostCli: true });
const phone = call({ role: "client", deviceId: "dev_phone" });
const remote = call({ role: "client", deviceId: "dev_remote", localHostCli: undefined });
const helper = call({ role: "node" });

const chunk = (id: string, text: string) => ({
  id,
  source: "memory/2026-10-18.md",
  lineStart: 1,
  lineEnd: 2,
  text,
  provenance: "owner",
  claimId: "clm_1",
  tokenCount: 4,
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
});
const CLAIM = { id: "clm_1", text: "Mum's number is 555-0100", sources: ["chk_1"] };
const CHUNKS = [
  chunk("chk_1", "Messages from Mum: my card is 4111 1111 1111 1111"),
  chunk("chk_2", "Contacts: Mum 555-0100; Memory: secret plans"),
];

function build() {
  const handlers = {
    "memory.search": vi.fn(async () => ({ hits: CHUNKS.map((c) => ({ chunk: c, score: 1 })) })),
    "memory.explain": vi.fn(async () => ({ claim: CLAIM, chunks: CHUNKS })),
    "memory.claims.list": vi.fn(async () => ({ claims: [CLAIM] })),
  };
  const getClaim = vi.fn((id: string) => (id === "clm_1" ? CLAIM : undefined));
  const mounted = mountMemoryHandlers(handlers as unknown as MemoryHandlers, { getClaim } as never);
  const run = (name: string, c: Call, params: unknown) =>
    (mounted[name] as { run: (c: Call, p: never) => Promise<unknown> }).run(c, params as never);
  return { handlers, getClaim, run };
}

const explainText = (r: unknown) => JSON.stringify(r);

describe("memory.explain per connection", () => {
  it("desktop app and Host CLI still get the claim with its chunk text (positive control)", async () => {
    for (const c of [desktop, hostCli]) {
      const { run } = build();
      const r = (await run("memory.explain", c, { claimId: "clm_1" })) as {
        chunks: { text: string }[];
      };
      expect(r.chunks).toHaveLength(2);
      expect(explainText(r)).toContain("Messages from Mum");
      expect(explainText(r)).toContain("4111 1111 1111 1111");
    }
  });

  it.each([
    ["a paired phone", phone],
    ["a remote client", remote],
    ["a helper node", helper],
  ])("%s gets no chunk text and the store is never asked for chunks", async (_n, c) => {
    const { run, handlers, getClaim } = build();
    const r = (await run("memory.explain", c, { claimId: "clm_1" })) as {
      claim: { id: string };
      chunks: unknown[];
    };
    expect(r.claim.id).toBe("clm_1");
    expect(r.chunks).toEqual([]);
    const text = explainText(r);
    for (const leaked of ["Messages from Mum", "Contacts:", "4111", "secret plans"])
      expect(text).not.toContain(leaked);
    expect(handlers["memory.explain"]).not.toHaveBeenCalled();
    expect(getClaim).toHaveBeenCalledWith("clm_1");
  });

  it("an unknown claim is not_found for a phone as well as for the desktop", async () => {
    const { run, handlers } = build();
    handlers["memory.explain"].mockRejectedValueOnce(new PsycheError("not_found", "no such claim"));
    await expect(run("memory.explain", desktop, { claimId: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(run("memory.explain", phone, { claimId: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("memory.search per connection", () => {
  it("desktop app and Host CLI keep their hits (positive control)", async () => {
    for (const c of [desktop, hostCli]) {
      const { run } = build();
      const r = (await run("memory.search", c, { query: "mum" })) as { hits: unknown[] };
      expect(r.hits).toHaveLength(2);
    }
  });

  it.each([
    ["a paired phone", phone],
    ["a remote client", remote],
    ["a helper node", helper],
  ])("%s gets no hits and the index is never searched", async (_n, c) => {
    const { run, handlers } = build();
    expect(await run("memory.search", c, { query: "mum" })).toEqual({ hits: [] });
    expect(handlers["memory.search"]).not.toHaveBeenCalled();
  });
});

describe("other memory methods stay mounted as before", () => {
  it("memory.claims.list is unchanged for a phone", async () => {
    const { run } = build();
    expect(await run("memory.claims.list", phone, {})).toEqual({ claims: [CLAIM] });
  });
});
