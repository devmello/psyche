import { createThread, getThread, openDb } from "@psyche/db";
import { DEFAULT_AUTO_MODE_ALLOWLIST } from "@psyche/model-router";
import type { ModelProvider } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { modelPinsFor, threadSettingsHandlers } from "../src/compose/threads.ts";
import type { Call } from "../src/context.ts";

/** A router-shaped provider: only what `modelPinsFor` reads. */
function routerWithPrimary(primary: string | undefined): ModelProvider {
  return {
    allowsAutoMode: (ref: string) => DEFAULT_AUTO_MODE_ALLOWLIST.some((p) => p.test(ref)),
    setThreadModel: async () => {},
    role: () => (primary === undefined ? undefined : { model: primary }),
  } as unknown as ModelProvider;
}

function update(primary: string | undefined, params: Record<string, unknown>) {
  const db = openDb(":memory:");
  const thread = createThread(db, { kind: "side", sessionKey: "test:side" });
  const events: string[] = [];
  const call = {
    ctx: { db, bus: { bumpStateVersion: () => {} } },
    emit: (name: string) => events.push(name),
  } as unknown as Call;
  const handler = threadSettingsHandlers(modelPinsFor(routerWithPrimary(primary)))[
    "threads.update"
  ];
  if (handler === undefined) throw new Error("threads.update is not registered");
  const run = () =>
    (handler.run as (c: Call, p: unknown) => Promise<unknown>)(call, {
      threadId: thread.id,
      ...params,
    });
  return { db, thread, run };
}

describe("threads.update: Auto on a thread with no pinned model", () => {
  it("is allowed when the router's default chat model is on the allowlist", async () => {
    const { db, thread, run } = update("anthropic/claude-sonnet-5-5", { permissionMode: "auto" });
    await run();
    expect(getThread(db, thread.id)?.permissionMode).toBe("auto");
  });

  it("is refused, naming the default model, when that model is not allowlisted", async () => {
    const { db, thread, run } = update("lmstudio/tiny-7b", { permissionMode: "auto" });
    await expect(run()).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("lmstudio/tiny-7b"),
    });
    expect(getThread(db, thread.id)?.permissionMode).not.toBe("auto");
  });

  it("is still refused with a /model hint when there is no default model", async () => {
    const { run } = update(undefined, { permissionMode: "auto" });
    await expect(run()).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("/model"),
    });
  });
});
