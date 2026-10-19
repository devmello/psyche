import type { MemoryStore } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  type ConformanceContext,
  type ConformanceFactory,
  expectPsycheError,
  newContext,
} from "./harness.ts";

export interface MemoryStoreConformanceContext extends ConformanceContext {
  /** The factory must accept this id as an approved `memory_protected_write`. */
  approvedApprovalId: string;
}

/** Architecture §4.8, security §8: workspace confinement, protected files, provenance. */
export function describeMemoryStoreConformance(
  name: string,
  factory: ConformanceFactory<MemoryStore, MemoryStoreConformanceContext>,
): void {
  const approvalId = "apr_conformance_memory";
  const setup = async () => {
    const ctx: MemoryStoreConformanceContext = { ...newContext(), approvedApprovalId: approvalId };
    return { store: await factory(ctx), clock: ctx.clock };
  };

  describe(`MemoryStore conformance: ${name}`, () => {
    it("round-trips a workspace file with an etag", async () => {
      const { store } = await setup();
      const written = await store.writeFile("notes/trip.md", "# Trip\nquokka island", {
        provenance: "owner",
      });
      expect(written.etag.length).toBeGreaterThan(0);
      const read = await store.readFile("notes/trip.md");
      expect(read?.content).toBe("# Trip\nquokka island");
      expect(read?.etag).toBe(written.etag);
      expect(await store.listFiles("notes/")).toContain("notes/trip.md");
      expect(await store.readFile("notes/missing.md")).toBeUndefined();
    });

    it("rejects a stale etag", async () => {
      const { store } = await setup();
      const first = await store.writeFile("a.md", "one", { provenance: "owner" });
      await store.writeFile("a.md", "two", { provenance: "owner", etag: first.etag });
      await expectPsycheError(
        store.writeFile("a.md", "three", { provenance: "owner", etag: first.etag }),
        "conflict",
      );
    });

    it("confines paths to the workspace", async () => {
      const { store } = await setup();
      for (const p of ["../escape.md", "/etc/passwd", "memory/../../escape.md"]) {
        await expectPsycheError(store.writeFile(p, "x", { provenance: "owner" }), "invalid_params");
        await expectPsycheError(store.readFile(p), "invalid_params");
      }
    });

    it("protects persona files", async () => {
      const { store } = await setup();
      await expectPsycheError(store.writeFile("USER.md", "x", { provenance: "owner" }));
      await store.writeFile("USER.md", "# About the owner", { provenance: "owner", approvalId });
      await expectPsycheError(
        store.writeFile("MEMORY.md", "injected", { provenance: "untrusted", approvalId }),
        "policy_denied",
      );
      expect((await store.readFile("USER.md"))?.content).toBe("# About the owner");
    });

    it("appends provenance-tagged daily notes that search finds", async () => {
      const { store, clock } = await setup();
      const { path, chunk } = await store.appendDailyNote({
        text: "Booked the wombat sanctuary",
        provenance: "owner",
      });
      expect(path).toBe(`memory/${clock.iso().slice(0, 10)}.md`);
      expect(chunk.provenance).toBe("owner");
      expect((await store.readFile(path))?.content).toContain("Booked the wombat sanctuary");
      const hits = await store.search("wombat sanctuary");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.chunk.text).toContain("wombat");
    });

    it("filters search by provenance", async () => {
      const { store } = await setup();
      await store.appendDailyNote({ text: "pangolin owner fact", provenance: "owner" });
      await store.appendDailyNote({
        text: "pangolin untrusted email claim",
        provenance: "untrusted",
      });
      const owner = await store.search("pangolin", { provenance: ["owner"] });
      expect(owner.length).toBeGreaterThan(0);
      expect(owner.every((h) => h.chunk.provenance === "owner")).toBe(true);
      const all = await store.search("pangolin");
      expect(all.some((h) => h.chunk.provenance === "untrusted")).toBe(true);
    });

    it("never promotes untrusted content to an owner claim", async () => {
      const { store } = await setup();
      const { chunk } = await store.appendDailyNote({
        text: "the owner loves wire transfers",
        provenance: "untrusted",
      });
      await expectPsycheError(
        store.addClaim({
          text: "Owner loves wire transfers",
          kind: "preference",
          provenance: "owner",
          confidence: 0.9,
          sources: [chunk.id],
        }),
        "policy_denied",
      );
      const claim = await store.addClaim({
        text: "An email claimed the owner loves wire transfers",
        kind: "fact",
        provenance: "untrusted",
        confidence: 0.2,
        sources: [chunk.id],
      });
      expect(claim.provenance).toBe("untrusted");
    });

    it("explains a claim with its sources and forgets it", async () => {
      const { store } = await setup();
      const { chunk } = await store.appendDailyNote({
        text: "Pat is allergic to axolotl dander",
        provenance: "owner",
      });
      const claim = await store.addClaim({
        text: "Pat is allergic to axolotl dander",
        kind: "fact",
        provenance: "owner",
        confidence: 0.9,
        sources: [chunk.id],
      });
      const explained = await store.explain(claim.id);
      expect(explained?.chunks.map((c) => c.id)).toContain(chunk.id);

      const dry = await store.forget("axolotl", { dryRun: true });
      expect(dry.retractedClaimIds).toContain(claim.id);
      expect((await store.search("axolotl")).length).toBeGreaterThan(0);

      const done = await store.forget("axolotl");
      expect(done.retractedClaimIds).toContain(claim.id);
      expect(await store.search("axolotl")).toHaveLength(0);
      expect((await store.listClaims()).map((c) => c.id)).not.toContain(claim.id);
      expect((await store.listClaims({ includeRetracted: true })).map((c) => c.id)).toContain(
        claim.id,
      );
    });
  });
}
