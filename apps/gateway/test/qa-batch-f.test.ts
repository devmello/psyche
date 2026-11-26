import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, setSetting } from "@psyche/db";
import type { ContextUsage } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, usageKey } from "../src/compose/context.ts";
import { bridgeSocketSetup } from "../src/compose/parts.ts";
import { previewText } from "../src/handlers/threads.ts";
import { GatedAgentLoop } from "./agent.ts";
import {
  desktopClient,
  ik,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

let t: TestGateway | undefined;
let c: TestClient | undefined;
afterEach(async () => {
  c?.close();
  await t?.cleanup();
  t = undefined;
  c = undefined;
});

describe("item 11: blank messages", () => {
  it("chat.send refuses whitespace-only content and starts no run; real text still runs", async () => {
    const agent = new GatedAgentLoop();
    t = await startTestGateway({ agent });
    c = await desktopClient(t.gateway);
    const { thread } = await c.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "side" },
      ik(),
    );
    for (const content of ["   ", "\n\t ", " "]) {
      await expect(c.call("chat.send", { threadId: thread.id, content }, ik())).rejects.toThrow(
        /invalid_params/,
      );
    }
    expect(agent.turns).toHaveLength(0);
    agent.script([
      { type: "run.status", status: "running" },
      { type: "end", outcome: "final" },
    ]);
    await c.call("chat.send", { threadId: thread.id, content: " hi " }, ik());
    await c.waitForEvent(
      (e) =>
        e.event === "run.updated" &&
        (e.payload as { run: { status: string } }).run.status === "done",
    );
    expect(agent.turns).toHaveLength(1);
  });
});

describe("item 12: thread preview", () => {
  it("keeps underscores, pipes and lone asterisks the owner typed", () => {
    expect(previewText("Use exec_host to run the command: ls -la /tmp | head -5")).toBe(
      "Use exec_host to run the command: ls -la /tmp | head -5",
    );
    expect(previewText("2 * 3 = 6 and my_var_name")).toBe("2 * 3 = 6 and my_var_name");
  });
  it("still strips real markdown", () => {
    expect(previewText("# Title\n> quoted **bold** and *it* and _em_ `code` ~~gone~~")).toBe(
      "Title quoted bold and it and em code gone",
    );
    expect(previewText("| a | b |")).toBe("a b");
    expect(previewText("see [docs](http://x.y) ```\nfence\n``` end")).toBe("see docs end");
  });
});

describe("item 17: unknown HTTP path", () => {
  it("answers an unknown path, / included, with a plain 404 that names what it serves", async () => {
    t = await startTestGateway();
    // No web UI any more (browser access dropped, 2026-11-25): no build hint, even for `/`.
    for (const path of ["/readyz", "/"]) {
      const res = await fetch(`${t.gateway.origin}${path}`);
      expect(res.status).toBe(404);
      const { error } = (await res.json()) as { error: string };
      expect(error).not.toMatch(/web UI/);
      expect(error).toMatch(/\/healthz/);
    }
    // Positive control: the health check still answers.
    expect((await fetch(`${t.gateway.origin}/healthz`)).status).toBe(200);
  });
});

describe("item 18: bridge socket directory", () => {
  it.skipIf(process.getuid?.() === 0)(
    "fails at setup, naming the variable, for a shared directory",
    () => {
      expect(() => bridgeSocketSetup({ PSYCHE_BROWSER_BRIDGE_SOCKET: "/tmp/pqg-1.sock" })).toThrow(
        /PSYCHE_BROWSER_BRIDGE_SOCKET/,
      );
    },
  );
  it("refuses a symlinked directory", () => {
    const base = mkdtempSync(join(tmpdir(), "psy-bridge-"));
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "link"));
    expect(() =>
      bridgeSocketSetup({ PSYCHE_BROWSER_BRIDGE_SOCKET: join(base, "link", "b.sock") }),
    ).toThrow(/PSYCHE_BROWSER_BRIDGE_SOCKET/);
  });
  it("accepts our own directory and one that does not exist yet", () => {
    const base = mkdtempSync(join(tmpdir(), "psy-bridge-"));
    expect(bridgeSocketSetup({ PSYCHE_BROWSER_BRIDGE_SOCKET: join(base, "b.sock") })).toEqual({
      socketPath: join(base, "b.sock"),
    });
    expect(
      bridgeSocketSetup({ PSYCHE_BROWSER_BRIDGE_SOCKET: join(base, "new", "b.sock") }),
    ).toEqual({ socketPath: join(base, "new", "b.sock") });
  });
});

describe("item 15: usage after a compaction", () => {
  it("counts the compaction and shows the size it left", async () => {
    t = await startTestGateway();
    const db = t.gateway.context.db;
    c = await desktopClient(t.gateway);
    const { thread } = await c.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "side" },
      ik(),
    );
    const published: unknown[] = [];
    const ctx = createContext({
      db,
      audit: { append: async () => undefined } as never,
      broker: {} as never,
      publish: (_e, p) => published.push(p),
      isRunning: () => false,
    });
    const usage = {
      threadId: thread.id,
      promptTokens: 173,
      compactions: 0,
      estimated: false,
    } as ContextUsage;
    setSetting(db, usageKey(thread.id), usage);
    await ctx.onCompaction({
      threadId: thread.id,
      runId: "r",
      compactionId: "c1",
      trigger: "manual",
      summary: { facts: [], decisions: [], openTasks: [], pinnedInstructions: [] },
      replacedTurns: 2,
      keptTurns: 1,
      tokensBefore: 173,
      tokensAfter: 114,
    });
    const after = getSetting(db, usageKey(thread.id))?.value as ContextUsage;
    expect(after).toMatchObject({ promptTokens: 114, compactions: 1, estimated: true });
    expect(published.length).toBeGreaterThan(0);
  });
});
