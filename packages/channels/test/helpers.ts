import type { Channel, ChannelCapabilities, ChannelType } from "@psyche/protocol";
import {
  FakeChannelAdapter,
  FakeClock,
  FakeNotifier,
  FakePermissionBroker,
  FakeSpeechEngine,
} from "@psyche/testing";
import type { ChannelInboundEvent, LibraryIngestInput } from "../src/ports.ts";
import {
  ChannelService,
  type InboundDecisionEvent,
  type PairingDecidedEvent,
} from "../src/service.ts";
import { MemoryChannelStore } from "../src/store/memory.ts";
import { FakeVoiceTranscoder, VoiceNotes } from "../src/voice.ts";

export const OWNER = "1001";
export const FRIEND = "2002";
export const STRANGER = "3003";
export const GROUP = "-100500";

export interface Harness {
  clock: FakeClock;
  store: MemoryChannelStore;
  broker: FakePermissionBroker;
  notifier: FakeNotifier;
  speech: FakeSpeechEngine;
  transcoder: FakeVoiceTranscoder;
  service: ChannelService;
  delivered: ChannelInboundEvent[];
  ingested: LibraryIngestInput[];
  events: { event: string; payload: unknown }[];
  sleeps: number[];
  adapter: FakeChannelAdapter;
  channel: Channel;
  /** What `onInboundDecision` reported. */
  decisions: InboundDecisionEvent[];
  /** `onPairingDecided` calls, with how many texts the adapter had sent at that moment. */
  pairingDecisions: { event: PairingDecidedEvent; sentBefore: number }[];
}

let counter = 0;

export async function harness(
  options: {
    channel?: Partial<Channel>;
    type?: ChannelType;
    ownerAllowFrom?: string[];
    capabilities?: Partial<ChannelCapabilities>;
    start?: boolean;
    admitInbound?: ConstructorParameters<typeof ChannelService>[0]["admitInbound"];
  } = {},
): Promise<Harness> {
  const clock = new FakeClock();
  const store = new MemoryChannelStore({ clock, newId: () => `id${++counter}` });
  const broker = new FakePermissionBroker({ clock });
  const notifier = new FakeNotifier();
  const speech = new FakeSpeechEngine();
  const transcoder = new FakeVoiceTranscoder();
  const delivered: ChannelInboundEvent[] = [];
  const ingested: LibraryIngestInput[] = [];
  const events: { event: string; payload: unknown }[] = [];
  const sleeps: number[] = [];
  const decisions: InboundDecisionEvent[] = [];
  const pairingDecisions: Harness["pairingDecisions"] = [];
  let sentCount = () => 0;
  const service = new ChannelService({
    onInboundDecision: (e) => decisions.push(e),
    onPairingDecided: (event) => pairingDecisions.push({ event, sentBefore: sentCount() }),
    ...(options.admitInbound === undefined ? {} : { admitInbound: options.admitInbound }),
    store,
    broker,
    clock,
    notifier,
    speech,
    voice: new VoiceNotes({ speech, transcoder }),
    sink: {
      deliver: async (e) => {
        delivered.push(e);
      },
    },
    library: {
      ingest: async (input) => {
        ingested.push(input);
        return { libraryItemId: `lib${ingested.length}` };
      },
    },
    emit: (event, payload) => events.push({ event, payload }),
    sleep: async (ms) => {
      sleeps.push(ms);
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
  const type = options.type ?? "telegram";
  const base = service.newChannel(type, "psyche_bot");
  const channel = await service.saveChannel({
    ...base,
    ownerIds: [OWNER],
    allowFrom: [OWNER],
    ...options.channel,
  });
  const adapter = new FakeChannelAdapter({
    type,
    account: "psyche_bot",
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
  });
  sentCount = () => adapter.sent.filter((x) => x.kind !== "typing").length;
  service.attach(adapter);
  if (options.start !== false) await service.start(channel.id);
  return {
    clock,
    store,
    broker,
    notifier,
    speech,
    transcoder,
    service,
    delivered,
    ingested,
    events,
    sleeps,
    adapter,
    channel,
    decisions,
    pairingDecisions,
  };
}

/** Text of everything the adapter sent, in order. */
export function sentTexts(h: Harness): string[] {
  return h.adapter.sent.filter((s) => s.kind !== "typing").map((s) => s.text);
}
