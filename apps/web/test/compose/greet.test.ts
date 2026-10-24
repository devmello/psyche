import { describe, expect, it } from "vitest";
import { greetMainChat } from "../../src/compose/PsycheApp.tsx";

describe("greetMainChat (#555)", () => {
  it("asks the Gateway to greet in the main chat", async () => {
    const calls: { method: string; params: unknown; key?: string }[] = [];
    await greetMainChat(async (method, params, options) => {
      calls.push({
        method,
        params,
        ...(options?.idempotencyKey ? { key: options.idempotencyKey } : {}),
      });
      if (method === "threads.list") return { threads: [{ thread: { id: "thr_main" } }] };
      return { started: true, runId: "run_1" };
    });
    expect(calls.map((c) => c.method)).toEqual(["threads.list", "chat.greet"]);
    expect(calls[0]?.params).toEqual({ kind: "main" });
    expect(calls[1]?.params).toEqual({ threadId: "thr_main" });
    expect(calls[1]?.key).toMatch(/^onboarding:greet:thr_main:/);
  });

  it("never blocks onboarding when the Gateway cannot greet", async () => {
    await expect(
      greetMainChat(async (method) => {
        if (method === "threads.list") return { threads: [{ thread: { id: "thr_main" } }] };
        throw Object.assign(new Error("unknown method"), { code: "method_not_found" });
      }),
    ).resolves.toBeUndefined();
  });
});
