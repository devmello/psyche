import type { Channel, MessagesMessage, MessagesReadResult } from "@psyche/protocol";
import { FakeClock, FakeMessagesNode, FakePermissionBroker } from "@psyche/testing";
import {
  IMessageAdapter,
  type IMessageAdapterOptions,
  type IMessageSendIntent,
  MemoryCursorStore,
} from "../../src/adapters/imessage/index.ts";
import type { ChannelInboundEvent } from "../../src/ports.ts";
import { ChannelService } from "../../src/service.ts";
import { MemoryChannelStore } from "../../src/store/memory.ts";

export const OWNER = "+15550001111";
export const FRIEND = "+15550002222";
export const STRANGER = "+15550003333";
export const ACCOUNT = "psyche@icloud.com";
export const dm = (handle: string, service = "iMessage") => `${service};-;${handle}`;

export interface Harness {
  clock: FakeClock;
  node: FakeMessagesNode;
  cursor: MemoryCursorStore;
  adapter: IMessageAdapter;
  service: ChannelService;
  /** The chat-approval broker (cards answered from iMessage). */
  broker: FakePermissionBroker;
  /** Stands in for the Gateway's broker behind `authorizeSend` (the owner approves on the Mac). */
  sendBroker: FakePermissionBroker;
  intents: IMessageSendIntent[];
  delivered: ChannelInboundEvent[];
  events: { event: string; payload: unknown }[];
  sleeps: number[];
  channel: Channel;
  /** Text of every `messages.send`, in order. */
  sent(): string[];
  /** Waits until the adapter has handled every queued row. */
  settle(): Promise<void>;
}

let counter = 0;

export async function harness(
  options: {
    channel?: Partial<Channel>;
    ownerAllowFrom?: string[];
    cursor?: MemoryCursorStore;
    node?: FakeMessagesNode;
    adapter?: Partial<IMessageAdapterOptions>;
    start?: boolean;
    /** Sleeps after which the reconnect loop gives up (the test's "stop"). */
    maxSleeps?: number;
  } = {},
): Promise<Harness> {
  const clock = new FakeClock();
  const node = options.node ?? new FakeMessagesNode();
  const cursor = options.cursor ?? new MemoryCursorStore();
  const broker = new FakePermissionBroker({ clock });
  const sendBroker = new FakePermissionBroker({ clock, armDelayMs: 0 });
  const intents: IMessageSendIntent[] = [];
  const delivered: ChannelInboundEvent[] = [];
  const events: { event: string; payload: unknown }[] = [];
  const sleeps: number[] = [];
  const maxSleeps = options.maxSleeps ?? 50;
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
    emit: (event, payload) => events.push({ event, payload }),
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length > maxSleeps) throw new Error("test: stop retrying");
      clock.advance(ms);
    },
    ownerAllowFrom: options.ownerAllowFrom ?? [],
    random: () => 0.5,
    pairingRandom: (() => {
      let i = 0;
      return (max: number) => i++ % max;
    })(),
  });
  await service.init();
  const channel = await service.saveChannel({
    ...service.newChannel("imessage", ACCOUNT),
    ownerIds: [OWNER],
    allowFrom: [OWNER],
    ...options.channel,
  });
  const adapter = new IMessageAdapter({
    account: ACCOUNT,
    node: () => node,
    cursor,
    clock,
    // The Gateway's authorizer: a real `message_send` approval for exactly this intent.
    authorizeSend: async (intent) => {
      intents.push(intent);
      const issued = await sendBroker.requestApproval({
        kind: "message_send",
        summary: `iMessage ${intent.purpose}`,
        details: { recipient: intent.recipient },
        bindingHash: intent.bindingHash,
        grantKey: intent.grantKey,
        requestedBy: { runId: null, taskId: null, threadId: null, agent: "channel:imessage" },
        sideEffect: "destructive",
        targetKind: "recipient",
        target: { kind: "recipient", value: intent.recipient },
        surfaces: ["desktop"],
        taint: false,
      });
      await sendBroker.answer({
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop ?? "",
        decision: "approve",
        scope: "once",
        decidedBy: { deviceId: "dev_owner_mac" },
      });
      return issued.approval.id;
    },
    ...options.adapter,
  });
  service.attach(adapter);
  if (options.start !== false) await service.start(channel.id);
  return {
    clock,
    node,
    cursor,
    adapter,
    service,
    broker,
    sendBroker,
    intents,
    delivered,
    events,
    sleeps,
    channel,
    sent: () => node.sends.map((s) => s.text),
    settle: () => adapter.idle(),
  };
}

/** The newest row Psyche itself sent (the echo of the last `messages.send`). */
export async function lastEcho(node: FakeMessagesNode): Promise<MessagesMessage> {
  const res = await node.invoke("messages.read", { limit: 200 });
  const rows = (res.result as MessagesReadResult).messages.filter((m) => m.isFromMe);
  const last = rows.at(-1);
  if (last === undefined) throw new Error("nothing sent");
  return last;
}
