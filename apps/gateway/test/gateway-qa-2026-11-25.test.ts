import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getThread } from "@psyche/db";
import type { ModelProvider } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { partsFromEnv } from "../src/compose/parts.ts";
import { silentLogger } from "../src/log.ts";
import { GatedAgentLoop } from "./agent.ts";
import {
  adminClient,
  desktopClient,
  ik,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

let t: TestGateway | undefined;
let c: TestClient | undefined;
let composed: ComposedGateway | null = null;
let home = "";
afterEach(async () => {
  c?.close();
  await t?.cleanup();
  await composed?.stop("test");
  composed = null;
  t = undefined;
  c = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

async function sideThread(client: TestClient): Promise<string> {
  const { thread } = await client.call<{ thread: { id: string } }>(
    "threads.create",
    { kind: "side" },
    ik(),
  );
  return thread.id;
}

describe("chat.send to an archived thread", () => {
  it("unarchives the thread when the owner sends into it", async () => {
    const agent = new GatedAgentLoop();
    t = await startTestGateway({ agent });
    c = await desktopClient(t.gateway);
    const threadId = await sideThread(c);
    await c.call("threads.archive", { threadId }, ik());
    expect(getThread(t.gateway.context.db, threadId)?.archivedAt).not.toBeNull();
    agent.script([
      { type: "run.status", status: "running" },
      { type: "end", outcome: "final" },
    ]);
    await c.call("chat.send", { threadId, content: "still there?" }, ik());
    await c.waitForEvent(
      (e) =>
        e.event === "run.updated" &&
        (e.payload as { run: { status: string } }).run.status === "done",
    );
    expect(getThread(t.gateway.context.db, threadId)?.archivedAt).toBeNull();
  });
});

describe("threads.setContextLimits", () => {
  it("keeps the thread's other limits when one is set", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-qa-limits-"));
    // The context method is wired by composeGateway (a bare test gateway does not have it).
    const provider = {
      id: "stub",
      capabilities: async () => ({ contextWindow: 16_000 }) as never,
      // biome-ignore lint/correctness/useYield: a stub that never runs a turn
      async *stream() {
        return;
      },
    } as unknown as ModelProvider;
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db") },
      model: { provider, model: "stub/main" },
    });
    const owner = await adminClient(composed.gateway);
    c = owner;
    const threadId = await sideThread(owner);
    await owner.call("threads.setContextLimits", { threadId, limits: { compactAt: 0.3 } }, ik());
    const second = await owner.call<{
      threadLimits: { compactAt?: number; keepRecentTurns?: number };
      limits: { compactAt: number };
    }>("threads.setContextLimits", { threadId, limits: { keepRecentTurns: 2 } }, ik());
    expect(second.threadLimits).toEqual({ compactAt: 0.3, keepRecentTurns: 2 });
    expect(second.limits.compactAt).toBe(0.3);
  });
});

describe("bridge socket at startup", () => {
  it.skipIf(process.getuid?.() === 0)(
    "fails in the startup config, before any part is composed or the server binds",
    () => {
      // `main.ts` calls `partsFromEnv(process.env)` before `composeGateway`/`startGateway`.
      expect(() =>
        partsFromEnv({ PSYCHE_BROWSER_BRIDGE_SOCKET: "/tmp/pqg-2026-11-25.sock" }),
      ).toThrow(/PSYCHE_BROWSER_BRIDGE_SOCKET/);
    },
  );
});
