import { AUDIT_GENESIS_HASH, type AuditLog } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { canonicalJSON, sha256 } from "../canonical.ts";
import { type ConformanceFactory, newContext } from "./harness.ts";

/** Security §15.1: append-only, hash-chained, canonical-JSON hashes, verifiable. */
export function describeAuditLogConformance(
  name: string,
  factory: ConformanceFactory<AuditLog>,
): void {
  const setup = () => factory(newContext());
  const actor = { type: "agent" as const, runId: "run_conf" };

  describe(`AuditLog conformance: ${name}`, () => {
    it("starts the chain at the genesis hash", async () => {
      const log = await setup();
      const e = await log.append({ kind: "thread.created", actor, data: { threadId: "thr_1" } });
      expect(e.seq).toBe(0);
      expect(e.prev).toBe(AUDIT_GENESIS_HASH);
      expect(e.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
    });

    it("chains entries with contiguous seq and recomputable hashes", async () => {
      const log = await setup();
      for (let i = 0; i < 5; i += 1) {
        await log.append({
          kind: i % 2 === 0 ? "tool_call.decided" : "approval.created",
          actor,
          subject: { toolCallId: `call_${i}` },
          data: { i, decision: "ask" },
        });
      }
      const entries = await log.list();
      expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
      entries.forEach((e, i) => {
        if (i > 0) expect(e.prev).toBe(entries[i - 1]?.hash);
        const { hash, ...rest } = e;
        expect(hash).toBe(sha256(canonicalJSON(rest)));
      });
      expect(await log.verify()).toEqual({ ok: true, count: 5 });
    });

    it("filters by kind and seq", async () => {
      const log = await setup();
      await log.append({ kind: "a", actor, data: {} });
      await log.append({ kind: "b", actor, data: {} });
      await log.append({ kind: "a", actor, data: {} });
      expect((await log.list({ kind: "a" })).map((e) => e.seq)).toEqual([0, 2]);
      expect((await log.list({ sinceSeq: 1 })).map((e) => e.seq)).toEqual([1, 2]);
      expect(await log.list({ limit: 1 })).toHaveLength(1);
    });

    it("verifies an empty log", async () => {
      const log = await setup();
      expect(await log.verify()).toEqual({ ok: true, count: 0 });
    });
  });
}
