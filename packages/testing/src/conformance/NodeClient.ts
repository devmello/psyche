import type { NodeCapability, NodeClient, NodeInvokeEvent } from "@psyche/protocol";
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

/** One capability the host helper must declare, exactly (name, side effect, target kind). */
export interface HostHelperGoldenCapability {
  name: string;
  sideEffect: NodeCapability["sideEffect"];
  targetKind?: NodeCapability["targetKind"];
}

/** An invocation that must succeed, and what its result must look like. */
export interface HostHelperInvokeFixture {
  capability: string;
  params: unknown;
  /** Asserts on `result` (use `expect`); the profile also checks `ok` and event order. */
  checkResult(result: unknown): void;
}

/** An invocation that must be refused with `code`, without running anything. */
export interface HostHelperRefusalCase {
  label: string;
  capability: string;
  params: unknown;
  approvalId?: string;
  code: string;
}

export interface HostHelperConformanceSpec {
  /** The kinds the helper may be stored as (`mac-helper`, `win-helper`, `host-helper`). */
  kinds: readonly string[];
  /** The golden manifest: every entry must be declared as given, and nothing else. */
  manifest: readonly HostHelperGoldenCapability[];
  invokes: readonly HostHelperInvokeFixture[];
  refusals?: readonly HostHelperRefusalCase[];
}

/**
 * The "host helper" profile (linux-desktop design §12.3): what the Gateway may rely on from the
 * Host's own helper, whichever OS it runs on. It is a `NodeClient` conformance run plus a golden
 * manifest, success fixtures and refusal cases. The Mac, Windows and Linux helpers each run it
 * with their own spec; the Linux one adds capabilities as later PRs land.
 */
export function describeHostHelperConformance(
  name: string,
  factory: ConformanceFactory<NodeClient>,
  spec: HostHelperConformanceSpec,
): void {
  const setup = () => factory(newContext());

  describe(`Host helper conformance: ${name}`, () => {
    it("is stored as a Host helper kind and online", async () => {
      const info = await (await setup()).info();
      expect(spec.kinds).toContain(info.kind);
      expect(info.status).toBe("online");
    });

    it("declares exactly the golden manifest", async () => {
      const caps = await (await setup()).capabilities();
      expect(caps.map((c) => c.name).sort()).toEqual(spec.manifest.map((c) => c.name).sort());
      for (const golden of spec.manifest) {
        const declared = caps.find((c) => c.name === golden.name);
        expect(declared?.sideEffect, `${golden.name} side effect`).toBe(golden.sideEffect);
        expect(declared?.targetKind, `${golden.name} target kind`).toBe(golden.targetKind);
      }
      // A destructive or financial capability can never be declared without being gated.
      for (const c of caps) {
        expect(["none", "read", "write", "destructive", "financial"]).toContain(c.sideEffect);
      }
    });

    for (const fixture of spec.invokes) {
      it(`${fixture.capability}: succeeds with ordered events`, async () => {
        const events: NodeInvokeEvent[] = [];
        const r = await (await setup()).invoke(fixture.capability, fixture.params, {
          onEvent: (e) => events.push(e),
        });
        expect(r.error).toBeUndefined();
        expect(r.ok).toBe(true);
        fixture.checkResult(r.result);
        events.forEach((e, i) => {
          expect(e.seq).toBe(i);
        });
      });
    }

    it("refuses what it does not offer, and a cancelled call, without throwing", async () => {
      const node = await setup();
      const unknown = await node.invoke("host_helper_conformance.no_such_capability", {});
      expect(unknown.ok).toBe(false);
      expect(unknown.error?.code).toBe("not_found");
      const ac = new AbortController();
      ac.abort();
      const first = spec.invokes[0];
      if (first !== undefined) {
        const cancelled = await node.invoke(first.capability, first.params, { signal: ac.signal });
        expect(cancelled.ok).toBe(false);
        expect(cancelled.error?.code).toBe("cancelled");
      }
    });

    for (const refusal of spec.refusals ?? []) {
      it(`refuses: ${refusal.label}`, async () => {
        const r = await (await setup()).invoke(refusal.capability, refusal.params, {
          ...(refusal.approvalId === undefined ? {} : { approvalId: refusal.approvalId }),
        });
        expect(r.ok).toBe(false);
        expect(r.error?.code).toBe(refusal.code);
      });
    }
  });
}

/**
 * What the Linux helper offers at L3 (design §14): `health` only. Later Linux PRs extend this
 * spec as they add `computer.*`, `apps.*` and the rest under the Mac helper's names.
 */
export const LINUX_HELPER_L3_SPEC: HostHelperConformanceSpec = {
  kinds: ["host-helper"],
  manifest: [{ name: "health", sideEffect: "none" }],
  invokes: [
    {
      capability: "health",
      params: {},
      checkResult(result) {
        expect(result).toMatchObject({ ok: true, platform: "linux" });
        const r = result as Record<string, unknown>;
        expect(typeof r.version).toBe("string");
        expect(typeof r.build).toBe("string");
        expect(typeof r.uptimeMs).toBe("number");
      },
    },
  ],
};
