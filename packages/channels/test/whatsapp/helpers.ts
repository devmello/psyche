import { createHmac } from "node:crypto";
import type { ApprovalRequestInput, Channel } from "@psyche/protocol";
import { FakeClock, FakePermissionBroker } from "@psyche/testing";
import {
  WhatsAppAdapter,
  type WhatsAppAdapterOptions,
  type WhatsAppWebhookRejection,
  type WhatsAppWebhookRequest,
} from "../../src/adapters/whatsapp/adapter.ts";
import type { WaMessage, WaNotification } from "../../src/adapters/whatsapp/mapping.ts";
import type { ChannelInboundEvent } from "../../src/ports.ts";
import { ChannelService } from "../../src/service.ts";
import { MemoryChannelStore } from "../../src/store/memory.ts";

/** Obviously fake secrets: nothing here is shaped like a real Meta credential. */
export const ACCESS = "fake-wa-access-token-not-real";
export const APP_SECRET = "fake-wa-app-secret-not-real";
export const VERIFY = "fake-wa-verify-token-not-real";
export const PSYCHE = "+15550009999";
export const PHONE_ID = "100200300400";
export const OWNER = "+15550001111";
export const FRIEND = "+15550002222";
export const STRANGER = "+15550003333";
export const MEDIA_URL = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1";

export interface GraphRequest {
  method: string;
  url: string;
  auth: string;
  json: Record<string, unknown> | undefined;
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

/** Stand-in for the Graph API (and the media CDN) behind an injected `fetch`. */
export class FakeGraph {
  readonly requests: GraphRequest[] = [];
  /** Replies for `POST …/messages`, in order; default a fresh wamid. */
  readonly replies: Reply[] = [];
  /** Other URLs (media metadata and downloads) → reply. */
  readonly routes = new Map<string, Reply>();
  #seq = 0;

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = typeof init?.body === "string" ? init.body : undefined;
    this.requests.push({
      method: init?.method ?? "GET",
      url,
      auth: headers.authorization ?? "",
      json: raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>),
    });
    const routed = this.routes.get(url);
    const next =
      routed ??
      (url.endsWith("/messages")
        ? (this.replies.shift() ?? {
            status: 200,
            body: { messaging_product: "whatsapp", messages: [{ id: `wamid.OUT${++this.#seq}` }] },
          })
        : { status: 404, body: { error: { code: 100 } } });
    const body =
      next.body instanceof Uint8Array || typeof next.body === "string"
        ? next.body
        : JSON.stringify(next.body);
    return new Response(body as ConstructorParameters<typeof Response>[0], {
      status: next.status,
      headers: next.headers,
    });
  }) as typeof fetch;

  /** Bodies of the sent messages, in order. */
  sends(): Record<string, unknown>[] {
    return this.requests
      .filter((r) => r.method === "POST" && r.url.endsWith("/messages"))
      .map((r) => r.json ?? {});
  }

  texts(): string[] {
    return this.sends().map((s) => {
      const text = s.text as { body?: string } | undefined;
      const interactive = s.interactive as { body?: { text?: string } } | undefined;
      return text?.body ?? interactive?.body?.text ?? "";
    });
  }
}

const secret = (value: string) => ({ use: <T>(fn: (v: string) => Promise<T>) => fn(value) });

export function adapter(
  graph: FakeGraph,
  extra: Partial<WhatsAppAdapterOptions> = {},
): WhatsAppAdapter {
  return new WhatsAppAdapter({
    number: PSYCHE,
    phoneNumberId: PHONE_ID,
    accessToken: secret(ACCESS),
    appSecret: secret(APP_SECRET),
    verifyToken: secret(VERIFY),
    fetch: graph.fetch,
    ...extra,
  });
}

let seq = 0;
export function nextWamid(): string {
  return `wamid.TEST${(++seq).toString(16).padStart(8, "0")}`;
}

/** A text message from `from` (E.164) at `atMs`. */
export function textMessage(from: string, body: string, atMs: number, extra: WaMessage = {}) {
  return {
    from: from.slice(1),
    id: nextWamid(),
    timestamp: String(Math.floor(atMs / 1000)),
    type: "text",
    text: { body },
    ...extra,
  } satisfies WaMessage;
}

export function notification(
  messages: WaMessage[],
  options: { phoneNumberId?: string; object?: string; statuses?: unknown[]; name?: string } = {},
): WaNotification {
  const from = typeof messages[0]?.from === "string" ? messages[0].from : "";
  return {
    object: options.object ?? "whatsapp_business_account",
    entry: [
      {
        id: "WABA_TEST",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: PSYCHE.slice(1),
                phone_number_id: options.phoneNumberId ?? PHONE_ID,
              },
              ...(messages.length === 0
                ? {}
                : {
                    contacts: [{ wa_id: from, profile: { name: options.name ?? "Test Person" } }],
                  }),
              ...(messages.length === 0 ? {} : { messages }),
              ...(options.statuses === undefined ? {} : { statuses: options.statuses }),
            },
          },
        ],
      },
    ],
  };
}

/**
 * Meta's documented algorithm, computed here independently of the adapter:
 * `sha256=` + hex(HMAC-SHA256(app secret, the exact raw body bytes)).
 */
export function metaSignature(secretValue: string, raw: Uint8Array): string {
  return `sha256=${createHmac("sha256", secretValue).update(raw).digest("hex")}`;
}

/** A signed POST of `payload` (or of the exact `raw` text). */
export function signedPost(
  payload: unknown,
  options: { secret?: string; raw?: string; signature?: string | null } = {},
): WhatsAppWebhookRequest {
  const raw = Buffer.from(options.raw ?? JSON.stringify(payload), "utf8");
  const sig =
    options.signature === null
      ? undefined
      : (options.signature ?? metaSignature(options.secret ?? APP_SECRET, raw));
  return {
    method: "POST",
    url: "/channels/whatsapp/webhook",
    headers: sig === undefined ? {} : { "x-hub-signature-256": sig },
    body: new Uint8Array(raw),
  };
}

export function handshake(params: Record<string, string>): WhatsAppWebhookRequest {
  return {
    method: "GET",
    url: `/channels/whatsapp/webhook?${new URLSearchParams(params).toString()}`,
    headers: {},
    body: new Uint8Array(),
  };
}

export function approvalInput(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    kind: "send_email",
    summary: 'Send "Re: invoice" to alice@example.org',
    details: { to: "alice@example.org", subject: "Re: invoice" },
    bindingHash: `sha256:${"a".repeat(64)}`,
    grantKey: "email.send:example.org",
    requestedBy: { runId: "run1", taskId: null, threadId: "t1" },
    sideEffect: "write",
    surfaces: ["desktop", `whatsapp:${OWNER}`],
    taint: false,
    ...overrides,
  };
}

/** A started WhatsApp channel behind a `ChannelService` with a fake broker. */
export async function harness(options: { channel?: Partial<Channel> } = {}) {
  const clock = new FakeClock();
  const broker = new FakePermissionBroker({ clock });
  const graph = new FakeGraph();
  const delivered: ChannelInboundEvent[] = [];
  const rejected: WhatsAppWebhookRejection[] = [];
  let n = 0;
  const service = new ChannelService({
    store: new MemoryChannelStore({ clock, newId: () => `id${++n}` }),
    broker,
    clock,
    sink: { deliver: async (e) => void delivered.push(e) },
    sleep: async (ms) => clock.advance(ms),
    random: () => 0.5,
    pairingRandom: () => 7,
  });
  await service.init();
  const channel = await service.saveChannel({
    ...service.newChannel("whatsapp", PSYCHE),
    dmPolicy: "pairing",
    ownerIds: [OWNER],
    allowFrom: [OWNER, FRIEND],
    ...options.channel,
  });
  const wa = adapter(graph, { clock, onRejected: (r) => void rejected.push(r) });
  service.attach(wa);
  await service.start(channel.id);
  /** Delivers a signed notification and waits for its handlers. */
  const post = async (messages: WaMessage[]) => {
    const res = await wa.handleWebhook(signedPost(notification(messages)));
    await wa.drain();
    return res;
  };
  const text = (from: string, body: string, extra: WaMessage = {}) =>
    post([textMessage(from, body, clock.now(), extra)]);
  return { clock, broker, graph, service, channel, wa, delivered, rejected, post, text };
}
