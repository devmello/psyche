import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalRequest, ChannelApprovalAnswer, InboundMessage } from "@psyche/protocol";
import type { Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { TelegramAdapter, type TelegramAdapterOptions } from "../../src/adapters/telegram/index.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "telegram");

function load<T>(name: string): Record<string, T> {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, T>;
}

export const updates = load<Update>("updates.json");
export const responses = load<ApiEnvelope>("responses.json");

export interface ApiEnvelope {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/** A fresh deep copy of a fixture update (tests mutate some). */
export function update(name: string): Update {
  const u = updates[name];
  if (u === undefined) throw new Error(`no fixture update ${name}`);
  return structuredClone(u);
}

export function response(name: string): ApiEnvelope {
  const r = responses[name];
  if (r === undefined) throw new Error(`no fixture response ${name}`);
  return structuredClone(r);
}

export const BOT_INFO = response("getMe").result as UserFromGetMe;
export const OWNER_ID = "48151623";
export const OWNER_CHAT = "48151623";
export const FAKE_TOKEN = "123456:TEST-TOKEN-abc";
/** 2026-10-18T22:00:00Z, the fixtures' base `date`. */
export const T0 = 1792360800_000;

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

type Responder = (payload: Record<string, unknown>) => ApiEnvelope;

/**
 * Stands in for api.telegram.org: records every call and answers from the recorded fixtures.
 * `override(method, envelope | fn)` changes one method's answer.
 */
export class FakeBotApi {
  readonly calls: ApiCall[] = [];
  #overrides = new Map<string, Responder>();
  #nextMessageId = 900;

  override(method: string, answer: ApiEnvelope | Responder): void {
    this.#overrides.set(method, typeof answer === "function" ? answer : () => answer);
  }

  callsTo(method: string): ApiCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  readonly transformer: Transformer = (async (
    _prev: unknown,
    method: string,
    payload: Record<string, unknown>,
  ): Promise<ApiEnvelope> => {
    this.calls.push({ method, payload });
    const override = this.#overrides.get(method);
    if (override !== undefined) return override(payload);
    const recorded = responses[method];
    if (recorded === undefined) throw new Error(`no fixture response for ${method}`);
    const env = structuredClone(recorded);
    if (method.startsWith("send") && method !== "sendChatAction") {
      const result = env.result as Record<string, unknown>;
      result.message_id = ++this.#nextMessageId;
      if (typeof payload.text === "string") result.text = payload.text;
    }
    return env;
  }) as unknown as Transformer;
}

export interface Harness {
  adapter: TelegramAdapter;
  api: FakeBotApi;
  inbound: InboundMessage[];
  answers: ChannelApprovalAnswer[];
  clock: { t: number; now(): number };
}

export async function harness(options: Partial<TelegramAdapterOptions> = {}): Promise<Harness> {
  const api = new FakeBotApi();
  const clock = {
    t: T0 + 600_000,
    now() {
      return this.t;
    },
  };
  const adapter = new TelegramAdapter({
    token: FAKE_TOKEN,
    botInfo: BOT_INFO,
    transformer: api.transformer,
    polling: false,
    clock,
    ...options,
  });
  const inbound: InboundMessage[] = [];
  const answers: ChannelApprovalAnswer[] = [];
  adapter.onInbound((m) => {
    inbound.push(m);
  });
  adapter.onApprovalAnswer((a) => {
    answers.push(a);
  });
  await adapter.start();
  return { adapter, api, inbound, answers, clock };
}

export function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "apr_01J9ZK4Q7WABCDEFGH",
    kind: "send_email",
    summary: "Email Sam the Q3 deck",
    details: { to: "sam@example.com", subject: "Q3 deck", attachments: 1 },
    bindingHash: "sha256:9f2c6a1e4b7d8c0f3a5e6b9d2c1f4e7a8b0c3d6e9f2a5b8c1d4e7f0a3b6c9d2e",
    grantKey: "send_email:sam@example.com",
    requestedBy: {
      runId: "run_01J9ZK4Q7WRUN0000001",
      taskId: null,
      threadId: "thr_01J9ZK4Q7WTHREAD0001",
      toolCallId: "tc_01J9ZK4Q7WTOOL00001",
      agent: "main",
    },
    sideEffect: "write",
    targetKind: "recipient",
    target: { kind: "recipient", value: "sam@example.com" },
    surfaces: ["desktop", "telegram:48151623"],
    scopesOffered: ["once"],
    deviceOnly: false,
    requiresAuthentication: false,
    taint: false,
    status: "pending",
    scopeGranted: null,
    decidedBy: null,
    requestedAt: "2026-10-18T22:10:00.000Z",
    expiresAt: "2026-10-18T22:25:00.000Z",
    decidedAt: null,
    grantId: null,
    ...overrides,
  };
}
