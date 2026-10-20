import { PsycheError } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISCORD_INTENTS,
  DISCORD_TOKEN_REJECTED,
  DiscordAdapter,
} from "../../src/adapters/discord/index.ts";
import { adapterOptions, FakeDiscord, message, TOKEN, until } from "./helpers.ts";

let fake: FakeDiscord;
let adapter: DiscordAdapter | undefined;

async function started(): Promise<DiscordAdapter> {
  fake = await FakeDiscord.create();
  adapter = new DiscordAdapter(adapterOptions(fake));
  await adapter.start();
  return adapter;
}

afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
  await fake?.close();
});

describe("DiscordAdapter gateway", () => {
  it("identifies with the three intents, heartbeats with the last seq, and is healthy when READY", async () => {
    const a = await started();
    const [identify] = fake.ops(2);
    expect(identify?.d).toMatchObject({ token: TOKEN, intents: DISCORD_INTENTS });
    expect(DISCORD_INTENTS).toBe(37376);
    await until(() => fake.ops(1).length >= 2);
    expect(fake.ops(1)[0]?.d).toBe(1);
    expect(await a.health()).toMatchObject({ ok: true });
  });

  it("resumes the session on the resume URL after a drop and keeps receiving events", async () => {
    const a = await started();
    const got: string[] = [];
    a.onInbound((m) => {
      got.push(m.text);
    });
    fake.dispatch("MESSAGE_CREATE", message({ content: "before" }));
    await until(() => got.length === 1);
    fake.drop();
    await until(() => fake.ops(6).length === 1);
    expect(fake.ops(6)[0]?.d).toEqual({ token: TOKEN, session_id: "sess-1", seq: 2 });
    expect(fake.ops(2)).toHaveLength(1);
    await until(() => a.connects === 2);
    await until(() => fake.received.some((p) => p.conn === 1 && p.op === 6));
    await new Promise((r) => setTimeout(r, 20));
    expect(await a.health()).toMatchObject({ ok: true });
    fake.dispatch("MESSAGE_CREATE", message({ id: "600000000000000002", content: "after" }));
    await until(() => got.length === 2);
    expect(got).toEqual(["before", "after"]);
  });

  it("a missed heartbeat ack drops the zombie connection and resumes", async () => {
    fake = await FakeDiscord.create();
    fake.ackHeartbeats = false;
    adapter = new DiscordAdapter(adapterOptions(fake));
    await adapter.start();
    await until(() => fake.ops(6).length >= 1);
    fake.ackHeartbeats = true;
    expect(fake.connections).toBeGreaterThanOrEqual(2);
  });

  it("RECONNECT (op 7) resumes; INVALID_SESSION (op 9, false) identifies afresh", async () => {
    await started();
    fake.send({ op: 7, d: null });
    await until(() => fake.ops(6).length === 1);
    await until(() => fake.connections === 2);
    await new Promise((r) => setTimeout(r, 20));
    fake.send({ op: 9, d: false });
    await until(() => fake.ops(2).length === 2);
  });

  it("4004: start fails with a fatal health detail and never reconnects with that token", async () => {
    fake = await FakeDiscord.create();
    fake.closeOnIdentify = 4004;
    adapter = new DiscordAdapter(adapterOptions(fake));
    const err = await adapter.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PsycheError);
    expect((err as PsycheError).code).toBe("unauthorized");
    expect((err as PsycheError).message).toBe(DISCORD_TOKEN_REJECTED);
    expect(await adapter.health()).toEqual({ ok: false, detail: DISCORD_TOKEN_REJECTED });
    await new Promise((r) => setTimeout(r, 60));
    expect(fake.connections).toBe(1);
    // A retry by the service fails fast, without opening the gateway again.
    await expect(adapter.start()).rejects.toThrow(DISCORD_TOKEN_REJECTED);
    expect(fake.connections).toBe(1);
  });

  it("4014: health says to enable the Message Content intent", async () => {
    fake = await FakeDiscord.create();
    fake.closeOnIdentify = 4014;
    adapter = new DiscordAdapter(adapterOptions(fake));
    await expect(adapter.start()).rejects.toThrow(/Message Content intent/);
    expect((await adapter.health()).detail).toMatch(/enable the Message Content intent/);
    await new Promise((r) => setTimeout(r, 40));
    expect(fake.connections).toBe(1);
  });

  it("stop closes the socket and health reports stopped", async () => {
    const a = await started();
    await a.stop();
    expect(await a.health()).toMatchObject({ ok: false, detail: "stopped" });
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.connections).toBe(1);
  });
});
