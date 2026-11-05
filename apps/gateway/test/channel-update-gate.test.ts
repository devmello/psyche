import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCursorStore } from "@psyche/channels";
import { isOwnerOnly } from "@psyche/hostfs";
import type { ModelEvent } from "@psyche/protocol";
import { FakeMessagesNode, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeChannels } from "../src/compose/channels.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { releaseAllGatewayLocks } from "../src/pre-update.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * A chat message that arrives while an app update is being prepared is held, not dropped, and
 * runs when service resumes (review M4).
 */

const ACCOUNT = "psyche@icloud.com";
const OWNER = "+15550001111";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason: "stop" },
];
const BASE = Date.parse("2026-10-19T12:00:00.000Z");
const started = Date.now();
const clock = { now: () => BASE + (Date.now() - started) };

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  releaseAllGatewayLocks();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("channel messages during an update", () => {
  it("holds a message while the gate is closed and answers it when the gate opens", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-chan-gate-"));
    const node = new FakeMessagesNode();
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      clock,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: {
        provider: FakeModelProvider.script([say("Hello from Psyche.")]),
        model: "fake/model",
      },
      parts: [
        (s) =>
          composeChannels(s, {
            imessage: { account: ACCOUNT, node: () => node, cursor: new MemoryCursorStore() },
            healthIntervalMs: 0,
          }),
      ],
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    await owner.call(
      "channels.configure",
      {
        type: "imessage",
        account: ACCOUNT,
        dmPolicy: "allowlist",
        allowFrom: [OWNER],
        ownerIds: [OWNER],
      },
      ik(),
    );
    await vi.waitFor(() =>
      expect(node.invocations.some((i) => i.capability === "messages.watch")).toBe(true),
    );

    const ready = await owner.call<{ ready: boolean }>("gateway.prepareUpdate", { waitMs: 0 });
    expect(ready.ready).toBe(true);
    node.receive({ from: OWNER, text: "are you there?" });
    // Nothing runs and nothing is lost while the door is shut.
    await new Promise((r) => setTimeout(r, 400));
    expect(node.sends).toHaveLength(0);
    const runs = composed.gateway.context.db.sqlite
      .prepare("SELECT count(*) AS n FROM runs")
      .get() as { n: number };
    expect(runs.n).toBe(0);

    // The update did not come: service resumes and the held message is answered.
    await owner.call("gateway.prepareUpdate", { mode: "cancel" });
    await vi.waitFor(() => expect(node.sends).toHaveLength(1), { timeout: 5000 });
    expect(node.sends[0]).toMatchObject({ text: "Hello from Psyche." });
  });

  it("survives the restart the update causes: a held message is replayed at the next start", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-chan-gate-"));
    const start = async (node: FakeMessagesNode, reply: string) =>
      composeGateway({
        logger: silentLogger,
        retentionIntervalMs: 0,
        background: false,
        clock,
        config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
        model: { provider: FakeModelProvider.script([say(reply)]), model: "fake/model" },
        parts: [
          (s) =>
            composeChannels(s, {
              imessage: { account: ACCOUNT, node: () => node, cursor: new MemoryCursorStore() },
              healthIntervalMs: 0,
            }),
        ],
      });
    const first = new FakeMessagesNode();
    composed = await start(first, "never sent");
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    await owner.call(
      "channels.configure",
      {
        type: "imessage",
        account: ACCOUNT,
        dmPolicy: "allowlist",
        allowFrom: [OWNER],
        ownerIds: [OWNER],
      },
      ik(),
    );
    await vi.waitFor(() =>
      expect(first.invocations.some((i) => i.capability === "messages.watch")).toBe(true),
    );
    await owner.call("gateway.prepareUpdate", { waitMs: 0 });
    first.receive({ from: OWNER, text: "remember to call mum" });
    // On disk, not only in memory: the adapter has already moved its cursor past the message.
    const held = join(home, "state", "channels", "held.json");
    await vi.waitFor(() => expect(existsSync(held)).toBe(true));
    expect(isOwnerOnly(held)).toBe(true);
    expect(JSON.parse(readFileSync(held, "utf8")).items[0].pending.content).toContain("call mum");
    expect(first.sends).toHaveLength(0);

    // The update stops the process (here: stop, with the gate still closed).
    for (const c of clients.splice(0)) c.close();
    await composed.stop("update");
    composed = null;

    // The new build starts on the same data and answers it.
    const second = new FakeMessagesNode();
    composed = await start(second, "I will remind you.");
    await vi.waitFor(() => expect(second.sends).toHaveLength(1), { timeout: 8000 });
    expect(second.sends[0]).toMatchObject({ text: "I will remind you." });
    await vi.waitFor(() => expect(existsSync(held)).toBe(false));
  }, 30_000);
});
