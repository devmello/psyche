import { describe, expect, it, vi } from "vitest";
import { bootstrapAdminIfNeeded } from "../../src/main/bootstrap-admin.ts";

function deps(over: Partial<Parameters<typeof bootstrapAdminIfNeeded>[0]> = {}) {
  return {
    packaged: true,
    scopes: () => ["operator.read", "operator.write", "operator.approvals"],
    call: vi.fn(async () => ({ device: { id: "d1" } })),
    reconnect: vi.fn(),
    warn: vi.fn(),
    now: () => 1,
    ...over,
  };
}

describe("bootstrapAdminIfNeeded", () => {
  it("asks once when paired without admin, then reconnects", async () => {
    const d = deps();
    expect(await bootstrapAdminIfNeeded(d)).toBe(true);
    expect(d.call).toHaveBeenCalledWith(
      "devices.bootstrapAdmin",
      {},
      {
        idempotencyKey: "bootstrap-admin:1",
      },
    );
    expect(d.reconnect).toHaveBeenCalledOnce();
  });

  it("does nothing when already admin or unpackaged", async () => {
    const admin = deps({ scopes: () => ["operator.admin"] });
    expect(await bootstrapAdminIfNeeded(admin)).toBe(false);
    const dev = deps({ packaged: false });
    expect(await bootstrapAdminIfNeeded(dev)).toBe(false);
    expect(admin.call).not.toHaveBeenCalled();
    expect(dev.call).not.toHaveBeenCalled();
  });

  it("treats conflict (an admin exists) as normal and warns on anything else", async () => {
    const conflict = deps({
      call: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "conflict" });
      }),
    });
    expect(await bootstrapAdminIfNeeded(conflict)).toBe(false);
    expect(conflict.warn).not.toHaveBeenCalled();
    expect(conflict.reconnect).not.toHaveBeenCalled();
    const forbidden = deps({
      call: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "forbidden" });
      }),
    });
    await bootstrapAdminIfNeeded(forbidden);
    expect(forbidden.warn).toHaveBeenCalledWith("first-admin bootstrap failed (forbidden)");
  });
});
