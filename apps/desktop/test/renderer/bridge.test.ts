import { describe, expect, it } from "vitest";
import { GatewayCallError, unwrapCall } from "../../src/renderer/bridge.ts";

describe("renderer bridge", () => {
  it("returns the value of an ok envelope", async () => {
    await expect(unwrapCall(Promise.resolve({ ok: true, value: { a: 1 } }))).resolves.toEqual({
      a: 1,
    });
  });

  it("rebuilds Gateway errors with their code and details on the renderer side", async () => {
    const err = await unwrapCall(
      Promise.resolve({
        ok: false,
        error: {
          code: "approval_required",
          message: "Approve the change first",
          details: { approvalId: "ap_1" },
        },
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayCallError);
    expect(err).toMatchObject({
      code: "approval_required",
      message: "Approve the change first",
      details: { approvalId: "ap_1" },
      retryable: false,
    });
  });
});
