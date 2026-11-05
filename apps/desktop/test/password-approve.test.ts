import { describe, expect, it, vi } from "vitest";
import { passwordApprove } from "../src/main/bridge/password-approve.ts";

/** The main-side handler for the window's password approval (linux design §9.4). */
describe("passwordApprove", () => {
  const linux = process.platform === "linux";

  it.skipIf(!linux)("forwards only the approval id and token to the Gateway", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    await passwordApprove(
      { call },
      { approvalId: "apr_1", answerToken: "tok", scope: "always", x: 1 },
    );
    expect(call).toHaveBeenCalledWith("approvals.approveWithPassword", {
      approvalId: "apr_1",
      answerToken: "tok",
    });
  });

  it.skipIf(!linux)("refuses a malformed payload before any call", () => {
    const call = vi.fn();
    for (const bad of [null, "x", {}, { approvalId: 1, answerToken: "t" }, { approvalId: "a" }]) {
      expect(() => passwordApprove({ call }, bad)).toThrow();
    }
    expect(call).not.toHaveBeenCalled();
  });

  it.skipIf(linux)("is unavailable off Linux", () => {
    const call = vi.fn();
    expect(() => passwordApprove({ call }, { approvalId: "a", answerToken: "t" })).toThrow(
      /Linux only/,
    );
    expect(call).not.toHaveBeenCalled();
  });
});
