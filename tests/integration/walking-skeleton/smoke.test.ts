import { FakeModelProvider } from "@psyche/testing";
import { afterEach, expect, it } from "vitest";
import { type Skeleton, startSkeleton } from "./harness.ts";

let sk: Skeleton | null = null;
afterEach(async () => {
  await sk?.stop();
  sk = null;
});

it("boots the composed Gateway, pairs the desktop client and streams a first turn", async () => {
  const provider = FakeModelProvider.script([
    [
      { type: "text_delta", text: "Hello, " },
      { type: "text_delta", text: "I am here." },
      { type: "finish", reason: "stop" },
    ],
  ]);
  const t0 = performance.now();
  sk = await startSkeleton({ model: { provider, model: "fake/main" } });
  const bootMs = performance.now() - t0;
  const c = sk.client;
  // First run: the shell opens (or creates) the one main thread.
  const { thread: main } = await c.call<{ thread: { id: string; kind: string } }>(
    "threads.create",
    { kind: "main" },
    true,
  );
  expect(main.kind).toBe("main");
  const from = c.mark;
  const sentAt = performance.now();
  const sent = await c.call<{ runId: string }>(
    "chat.send",
    { threadId: main.id, content: "hi" },
    true,
  );
  expect(sent.runId).toBeTruthy();
  await c.event("chat.delta", () => true, from);
  const firstDeltaMs = performance.now() - sentAt;
  const searchAt = performance.now();
  await c.call("memory.search", { query: "owner" });
  const searchMs = performance.now() - searchAt;
  // Gateway-side overhead with a model that answers at once (docs/status/int-1.md, timings).
  console.log(
    `INT-1 scripted timings ${JSON.stringify({ bootMs: Math.round(bootMs), firstDeltaMs: Math.round(firstDeltaMs), memorySearchMs: Math.round(searchMs) })}`,
  );
  expect(searchMs).toBeLessThan(100);
  await c.event<{ run: { status: string } }>("run.updated", (p) => p.run.status === "done", from);
});
