import { modelPinsFor, restoreModelPins } from "@psyche/gateway/compose";
import type { ModelRef, Thread } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type Skeleton, startSkeleton } from "../walking-skeleton/harness.ts";

/**
 * `threads.update` on the composed Gateway (C9 `/model`, `/plan`; B2 per-thread model): `auto`
 * only for allowlisted models, a non-allowlisted pick drops `auto` to `balanced`, the pin goes to
 * the router and survives a restart, and the loop hands the thread to the model so the router can
 * apply it.
 */

const ALLOWED = "anthropic/claude-sonnet-5-5";
const OTHER = "ollama/qwen3.8:27b";

/** The router's per-thread surface on a scripted provider (what `modelPinsFor` duck-types). */
class PinningProvider extends FakeModelProvider {
  readonly pins = new Map<string, ModelRef>();
  allowsAutoMode(ref: ModelRef): boolean {
    return ref === ALLOWED;
  }
  async setThreadModel(threadId: string, ref: ModelRef | undefined): Promise<void> {
    if (ref === "local/chat-only") throw new Error("not agent-capable");
    if (ref === undefined) this.pins.delete(threadId);
    else this.pins.set(threadId, ref);
  }
}

let sk: Skeleton | undefined;
afterEach(async () => {
  await sk?.stop();
  sk = undefined;
});

async function mainThread(s: Skeleton): Promise<Thread> {
  const res = await s.client.call<{ threads: { thread: Thread }[] }>("threads.list", {});
  const main = res.threads.find((t) => t.thread.kind === "main")?.thread;
  if (main) return main;
  return (await s.client.call<{ thread: Thread }>("threads.create", { kind: "main" }, true)).thread;
}

describe("threads.update", () => {
  it("pins a model, allows auto only for an allowlisted model and drops auto when the model changes", async () => {
    const provider = new PinningProvider();
    sk = await startSkeleton({ model: { provider, model: "fake/main" } });
    const thread = await mainThread(sk);

    await expect(
      sk.client.call("threads.update", { threadId: thread.id, permissionMode: "auto" }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const pinned = await sk.client.call<{ thread: Thread }>("threads.update", {
      threadId: thread.id,
      modelRef: ALLOWED,
      permissionMode: "auto",
    });
    expect(pinned.thread).toMatchObject({ modelRef: ALLOWED, permissionMode: "auto" });
    expect(provider.pins.get(thread.id)).toBe(ALLOWED);
    await sk.client.event<{ thread: Thread }>(
      "thread.updated",
      (p) => p.thread.id === thread.id && p.thread.permissionMode === "auto",
    );

    const other = await sk.client.call<{ thread: Thread }>("threads.update", {
      threadId: thread.id,
      modelRef: OTHER,
    });
    expect(other.thread).toMatchObject({ modelRef: OTHER, permissionMode: "balanced" });
    await expect(
      sk.client.call("threads.update", { threadId: thread.id, permissionMode: "auto" }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const plan = await sk.client.call<{ thread: Thread }>("threads.update", {
      threadId: thread.id,
      permissionMode: "plan",
      modelRef: null,
    });
    expect(plan.thread).toMatchObject({ modelRef: null, permissionMode: "plan" });
    expect(provider.pins.has(thread.id)).toBe(false);
  });

  it("re-applies stored pins to a fresh router after a restart", async () => {
    const provider = new PinningProvider();
    sk = await startSkeleton({ model: { provider, model: "fake/main" } });
    const thread = await mainThread(sk);
    await sk.client.call("threads.update", { threadId: thread.id, modelRef: ALLOWED });
    const restarted = new PinningProvider();
    const warnings: string[] = [];
    await restoreModelPins(sk.composed.db, modelPinsFor(restarted), (msg) => warnings.push(msg));
    expect(restarted.pins.get(thread.id)).toBe(ALLOWED);
    expect(warnings).toEqual([]);
  });

  it("refuses a model the router rejects without recording it", async () => {
    const provider = new PinningProvider();
    sk = await startSkeleton({ model: { provider, model: "fake/main" } });
    const thread = await mainThread(sk);
    await expect(
      sk.client.call("threads.update", { threadId: thread.id, modelRef: "local/chat-only" }),
    ).rejects.toBeTruthy();
    const after = await sk.client.call<{ thread: Thread }>("threads.get", { threadId: thread.id });
    expect(after.thread.modelRef).toBeNull();
  });

  it("hands the thread and run to the model so the router can apply the pin", async () => {
    const provider = new PinningProvider();
    sk = await startSkeleton({ model: { provider, model: "fake/main" } });
    const thread = await mainThread(sk);
    const from = sk.client.mark;
    const sent = await sk.client.call<{ runId: string }>(
      "chat.send",
      { threadId: thread.id, content: "hi" },
      true,
    );
    await sk.client.event<{ run: { id: string; status: string } }>(
      "run.updated",
      (p) => p.run.id === sent.runId && p.run.status === "done",
      from,
    );
    expect(provider.callContexts).toContainEqual({ threadId: thread.id, runId: sent.runId });
  });
});
