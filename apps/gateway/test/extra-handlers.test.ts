import { afterEach, describe, expect, it } from "vitest";
import type { HandlerDef } from "../src/context.ts";
import { desktopClient, startTestGateway, type TestGateway } from "./helpers.ts";

let t: TestGateway | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

describe("composed handlers", () => {
  it("mounts a package handler for a method the Gateway does not implement", async () => {
    const seen: string[] = [];
    const handlers: Record<string, HandlerDef> = {
      "approvals.list": {
        run(call) {
          seen.push(call.identity.deviceId);
          return { approvals: [], nextCursor: null };
        },
      },
    };
    t = await startTestGateway({ handlers });
    const c = await desktopClient(t.gateway);
    const res = await c.request("approvals.list", {});
    expect(res).toMatchObject({ ok: true, payload: { approvals: [], nextCursor: null } });
    expect(seen).toHaveLength(1);
    c.close();
  });

  it("refuses a handler for a method the Gateway already owns", async () => {
    await expect(
      startTestGateway({ handlers: { "threads.list": { run: () => ({}) } } }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a handler for an unknown method", async () => {
    await expect(
      startTestGateway({ handlers: { "nope.nothing": { run: () => ({}) } } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});
