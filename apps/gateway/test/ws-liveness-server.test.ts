import { afterEach, describe, expect, it } from "vitest";
import { desktopClient, startTestGateway, type TestGateway } from "./helpers.ts";

let t: TestGateway;
afterEach(async () => {
  await t?.cleanup();
});

const open = (gw: TestGateway) => [...gw.gateway.context.connections()].filter((c) => c.open);

describe("server ping", () => {
  it("terminates a peer that never answers pings and runs the connection cleanup", async () => {
    t = await startTestGateway({ wsPingIntervalMs: 40 });
    const dead = await desktopClient(t.gateway);
    // A sleeping phone: the socket stays up but nothing answers.
    (dead.ws as unknown as { pong: () => void }).pong = () => {};
    expect(open(t)).toHaveLength(1);
    await new Promise<void>((resolve) => dead.ws.once("close", () => resolve()));
    await new Promise((r) => setTimeout(r, 20));
    expect(open(t)).toHaveLength(0);
    expect([...t.gateway.context.connections()]).toHaveLength(0);
  });

  it("keeps a peer that answers pings (positive control)", async () => {
    t = await startTestGateway({ wsPingIntervalMs: 40 });
    const live = await desktopClient(t.gateway);
    let closed = false;
    live.ws.once("close", () => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(closed).toBe(false);
    expect(open(t)).toHaveLength(1);
    live.close();
  });
});
