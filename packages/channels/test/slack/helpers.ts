import type { Channel } from "@psyche/protocol";
import { FakeClock, FakePermissionBroker } from "@psyche/testing";
import { SlackAdapter, type SlackAdapterOptions } from "../../src/adapters/slack/index.ts";
import { type ChannelInboundEvent, staticSecret } from "../../src/ports.ts";
import { ChannelService } from "../../src/service.ts";
import { MemoryChannelStore } from "../../src/store/memory.ts";
import { APP_TOKEN, BOT_TOKEN, FakeSlack } from "./fake-slack.ts";

export const OWNER = "UOWNER001";
export const FRIEND = "UFRIEND01";
export const STRANGER = "USTRANGE1";
export const ACCOUNT = "acme";

export interface Harness {
  clock: FakeClock;
  slack: FakeSlack;
  adapter: SlackAdapter;
  service: ChannelService;
  broker: FakePermissionBroker;
  delivered: ChannelInboundEvent[];
  channel: Channel;
  /** Adapter reconnect waits, in ms. */
  sleeps: number[];
  settle(): Promise<void>;
}

let counter = 0;

export async function harness(
  options: {
    channel?: Partial<Channel>;
    adapter?: Partial<SlackAdapterOptions>;
    start?: boolean;
  } = {},
): Promise<Harness> {
  const clock = new FakeClock();
  const slack = new FakeSlack();
  const broker = new FakePermissionBroker({ clock });
  const delivered: ChannelInboundEvent[] = [];
  const sleeps: number[] = [];
  const store = new MemoryChannelStore({ clock, newId: () => `id${++counter}` });
  const service = new ChannelService({
    store,
    broker,
    clock,
    sink: {
      deliver: async (e) => {
        delivered.push(e);
      },
    },
    sleep: async () => {
      throw new Error("test: no service retries");
    },
    random: () => 0.5,
    pairingRandom: (() => {
      let i = 0;
      return (max: number) => i++ % max;
    })(),
  });
  await service.init();
  const channel = await service.saveChannel({
    ...service.newChannel("slack", ACCOUNT),
    ownerIds: [OWNER],
    allowFrom: [OWNER],
    ...options.channel,
  });
  const adapter = new SlackAdapter({
    botToken: staticSecret(BOT_TOKEN),
    appToken: staticSecret(APP_TOKEN),
    account: ACCOUNT,
    apiBase: "https://slack.example.test/api",
    fetch: slack.fetch,
    webSocket: slack.webSocket,
    fileHosts: ["files.example.test"],
    clock,
    // Reconnects wait for nothing in tests, but stop after a few so a bug cannot spin.
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      if (sleeps.length > 5) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      }
    },
    ...options.adapter,
  });
  service.attach(adapter);
  const h: Harness = {
    clock,
    slack,
    adapter,
    service,
    broker,
    delivered,
    channel,
    sleeps,
    settle: async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    },
  };
  if (options.start !== false) {
    await service.start(channel.id);
    await h.settle();
  }
  return h;
}
