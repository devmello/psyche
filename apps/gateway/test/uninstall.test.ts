import { PsycheError } from "@psyche/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ComposeServices } from "../src/compose/services.ts";
import type { signGate } from "../src/compose/skills.ts";
import { uninstallHandlers } from "../src/compose/uninstall.ts";
import type { Call } from "../src/context.ts";

const HOME = "/tmp/psyche-test-home-does-not-exist";
const audit = vi.fn(async () => undefined);
const services = { audit: { append: audit } } as unknown as ComposeServices;
const call = (over: { desktopShell?: boolean; remoteLoopback?: boolean } = {}) =>
  ({
    identity: { desktopShell: over.desktopShell ?? true, deviceId: "d1" },
    conn: { peer: { remoteLoopback: over.remoteLoopback ?? true, origin: null } },
  }) as unknown as Call;

type Handler = ReturnType<typeof uninstallHandlers>[string];
const run = (h: Handler | undefined, c: Call, p: unknown): Promise<unknown> => {
  if (h === undefined) throw new Error("no handler");
  return (h.run as unknown as (c: Call, p: unknown) => Promise<unknown>)(c, p);
};

describe("app.uninstall.authorize", () => {
  it("is for the desktop shell on this computer only", async () => {
    const gate = vi.fn(async (..._a: unknown[]) => undefined) as unknown as typeof signGate;
    const h = uninstallHandlers(services, gate, HOME)["app.uninstall.authorize"];
    for (const c of [call({ desktopShell: false }), call({ remoteLoopback: false })]) {
      await expect(run(h, c, { path: HOME })).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(gate).not.toHaveBeenCalled();
  });

  it("runs the presence gate, passes the approval on, and audits only after it passes", async () => {
    const gate = vi.fn(async (..._a: unknown[]) => undefined) as unknown as typeof signGate;
    const h = uninstallHandlers(services, gate, HOME)["app.uninstall.authorize"];
    await expect(run(h, call(), { path: HOME, approvalId: "apr_1" })).resolves.toEqual({
      authorized: true,
    });
    expect(gate).toHaveBeenCalledOnce();
    expect((gate as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[3]).toBe("apr_1");
    expect(audit).toHaveBeenCalledOnce();
  });

  it("a gate that asks for approval stops it with no audit", async () => {
    audit.mockClear();
    const gate = vi.fn(async (..._a: unknown[]) => {
      throw new PsycheError("approval_required", "needs approval", {
        details: { approvalId: "apr_2" },
      });
    }) as unknown as typeof signGate;
    const h = uninstallHandlers(services, gate, HOME)["app.uninstall.authorize"];
    await expect(run(h, call(), { path: HOME })).rejects.toMatchObject({
      code: "approval_required",
      details: { approvalId: "apr_2" },
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it("is only for this Gateway's own data folder, and the card names that folder", async () => {
    const gate = vi.fn(async (..._a: unknown[]) => undefined) as unknown as typeof signGate;
    const h = uninstallHandlers(services, gate, HOME)["app.uninstall.authorize"];
    for (const bad of ["/", "/Users", `${HOME}-other`, "relative"]) {
      await expect(run(h, call(), { path: bad }), bad).rejects.toMatchObject({
        code: "invalid_params",
      });
    }
    expect(gate).not.toHaveBeenCalled();
    await run(h, call(), { path: `${HOME}/` });
    const a = (gate as unknown as { mock: { calls: { 2: Record<string, unknown> }[] } }).mock
      .calls[0]?.[2] as { subject: { path: string }; details: { path: string }; summary: string };
    expect(a.subject.path).toBe(HOME);
    expect(a.details.path).toBe(HOME);
    expect(a.summary).toContain(HOME);
  });
});
