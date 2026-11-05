import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCursorStore } from "@psyche/channels";
import type { ModelEvent } from "@psyche/protocol";
import { FakeMessagesNode, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeChannels } from "../src/compose/channels.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Held channel messages are replayed at the next start, but not trusted (review round 3): a
 * thread that is gone, a message that is too old, or a sender who is no longer allowed never
 * stops the Gateway from starting and never runs.
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
  if (home) rmSync(home, { recursive: true, force: true });
});

const start = (node: FakeMessagesNode, reply: string) =>
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

/** A Gateway that held one message while closed, then stopped (the update). */
async function holdOneAndStop(afterHold?: (g: ComposedGateway) => void): Promise<string> {
  home = mkdtempSync(join(tmpdir(), "psyche-held-"));
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
  const held = join(home, "state", "channels", "held.json");
  await vi.waitFor(() => expect(existsSync(held)).toBe(true));
  afterHold?.(composed);
  for (const c of clients.splice(0)) c.close();
  await composed.stop("update");
  composed = null;
  return held;
}

const quiet = () => new Promise((r) => setTimeout(r, 1500));

describe("replaying held messages", () => {
  it("starts anyway when the thread of a held message is gone, and drops it", async () => {
    const held = await holdOneAndStop((g) => {
      g.gateway.context.db.sqlite.prepare("DELETE FROM threads").run();
    });
    const second = new FakeMessagesNode();
    // Starting must not throw, however the held message fares.
    composed = await start(second, "should not be sent");
    await vi.waitFor(() => expect(existsSync(held)).toBe(false));
    await quiet();
    expect(second.sends).toHaveLength(0);
    // And it stays gone: the next start has nothing to trip over either.
    await composed.stop("again");
    composed = await start(new FakeMessagesNode(), "x");
    expect(existsSync(held)).toBe(false);
  }, 60_000);

  it("does not run a message held for more than a day", async () => {
    const held = await holdOneAndStop();
    const file = JSON.parse(readFileSync(held, "utf8"));
    file.items[0].pending.heldAt = Date.now() - 25 * 3_600_000;
    writeFileSync(held, JSON.stringify(file));
    const second = new FakeMessagesNode();
    composed = await start(second, "should not be sent");
    await vi.waitFor(() => expect(existsSync(held)).toBe(false));
    await quiet();
    expect(second.sends).toHaveLength(0);
    expect(
      (
        composed.gateway.context.db.sqlite.prepare("SELECT count(*) AS n FROM runs").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  }, 60_000);

  it("re-checks the sender: a held message from someone no longer allowed does not run", async () => {
    const held = await holdOneAndStop();
    // The file says the owner; the policy of today says this sender is nobody (a sender
    // revoked during the hold, or a restored file naming someone else).
    const file = JSON.parse(readFileSync(held, "utf8"));
    file.items[0].pending.inbound.senderId = "+19998887777";
    writeFileSync(held, JSON.stringify(file));
    const second = new FakeMessagesNode();
    composed = await start(second, "should not be sent");
    await vi.waitFor(() => expect(existsSync(held)).toBe(false));
    await quiet();
    expect(second.sends).toHaveLength(0);
  }, 60_000);

  it("keeps a message whose channel is not attached yet, and does not run it", async () => {
    const held = await holdOneAndStop();
    const file = JSON.parse(readFileSync(held, "utf8"));
    expect(file.items).toHaveLength(1);
    // A Gateway without the iMessage adapter (another build, the Mac helper gone): the channel
    // row exists but nothing is attached to it.
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      clock,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: [(s) => composeChannels(s, { healthIntervalMs: 0 })],
    });
    await quiet();
    expect(existsSync(held)).toBe(true);
    expect(JSON.parse(readFileSync(held, "utf8")).items).toHaveLength(1);
  }, 60_000);
});
