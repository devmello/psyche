import type { NodeClient, NodeInvokeEvent } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { type ConformanceFactory, newContext } from "./harness.ts";

export interface NodeClientConformanceOptions {
  /** A side-effect-free capability that returns (and may stream) its params. */
  echo?: { capability: string; params: unknown };
  /** A destructive or financial capability, to check the approval requirement. */
  destructiveCapability?: string;
}

/** Architecture §7: info, capability manifest, invoke results never throw for remote errors. */
export function describeNodeClientConformance(
  name: string,
  factory: ConformanceFactory<NodeClient>,
  options: NodeClientConformanceOptions = {},
): void {
  const setup = () => factory(newContext());

  describe(`NodeClient conformance: ${name}`, () => {
    it("info matches the capability manifest", async () => {
      const node = await setup();
      const info = await node.info();
      expect(info.id).toBe(node.nodeId);
      const caps = await node.capabilities();
      expect(info.capabilities.map((c) => c.name).sort()).toEqual(caps.map((c) => c.name).sort());
      for (const c of caps)
        expect(["none", "read", "write", "destructive", "financial"]).toContain(c.sideEffect);
    });

    it("unknown capabilities resolve ok:false not_found", async () => {
      const node = await setup();
      const r = await node.invoke("conformance.no_such_capability", {});
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("not_found");
    });

    it("an aborted invocation resolves ok:false cancelled", async () => {
      const node = await setup();
      const ac = new AbortController();
      ac.abort();
      const cap = options.echo?.capability ?? "conformance.no_such_capability";
      const r = await node.invoke(cap, {}, { signal: ac.signal });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("cancelled");
    });

    it("echo invocations succeed with ordered events", async () => {
      if (options.echo === undefined) return;
      const node = await setup();
      const events: NodeInvokeEvent[] = [];
      const r = await node.invoke(options.echo.capability, options.echo.params, {
        onEvent: (e) => events.push(e),
      });
      expect(r.ok).toBe(true);
      expect(r.result).toEqual(options.echo.params);
      events.forEach((e, i) => {
        expect(e.seq).toBe(i);
      });
    });

    it("destructive capabilities require an approval id", async () => {
      if (options.destructiveCapability === undefined) return;
      const node = await setup();
      const r = await node.invoke(options.destructiveCapability, {});
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("approval_required");
    });
  });
}
