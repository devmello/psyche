import type { SlackWebSocket } from "../../src/adapters/slack/index.ts";

/**
 * An in-memory Slack: the Web API behind a `fetch` and Socket Mode behind a WebSocket factory.
 * It checks tokens like Slack does (bot token for the Web API, app token for
 * `apps.connections.open`), records every call, and lets a test push envelopes and see acks.
 */

export const BOT_TOKEN = "fake-slack-bot-token-SECRET";
export const APP_TOKEN = "fake-slack-app-token-SECRET";
export const BOT_USER = "UPSYCHE01";
export const TEAM = "T0TEAM";

export interface ApiCall {
  method: string;
  body: Record<string, unknown>;
  token: string;
}

export class FakeSocket implements SlackWebSocket {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    if (this.closed) throw new Error("closed");
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.({ code }));
  }

  /** Slack → adapter. */
  push(envelope: unknown): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }

  /** The server drops the connection. */
  drop(): void {
    this.close(1006);
  }
}

export class FakeSlack {
  readonly calls: ApiCall[] = [];
  readonly sockets: FakeSocket[] = [];
  readonly files = new Map<string, Uint8Array>();
  /** Responses by method, overriding the defaults (e.g. `{ok: false, error: "invalid_auth"}`). */
  readonly override = new Map<
    string,
    () => { status?: number; body: unknown; headers?: Record<string, string> }
  >();
  #ts = 1700000000;
  #envelope = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const token = auth.replace(/^Bearer /, "");
    if (url.hostname === "files.example.test") {
      if (token !== BOT_TOKEN) return new Response("forbidden", { status: 403 });
      const data = this.files.get(url.pathname);
      return data === undefined ? new Response("missing", { status: 404 }) : new Response(data);
    }
    const method = url.pathname.replace(/^\/api\//, "");
    const body =
      init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
    this.calls.push({ method, body, token });
    const o = this.override.get(method);
    if (o !== undefined) {
      const r = o();
      return new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        ...(r.headers === undefined ? {} : { headers: r.headers }),
      });
    }
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (method === "apps.connections.open") {
      if (token !== APP_TOKEN) return json({ ok: false, error: "not_allowed_token_type" });
      return json({
        ok: true,
        url: `wss://wss.example.test/link/?ticket=${this.sockets.length + 1}`,
      });
    }
    if (token !== BOT_TOKEN) return json({ ok: false, error: "invalid_auth" });
    switch (method) {
      case "auth.test":
        return json({ ok: true, user_id: BOT_USER, bot_id: "BPSYCHE", team_id: TEAM });
      case "chat.postMessage":
        return json({ ok: true, channel: body.channel, ts: `${++this.#ts}.000100` });
      case "chat.update":
        return json({ ok: true });
      case "conversations.open":
        return json({ ok: true, channel: { id: `D${String(body.users)}` } });
      default:
        return json({ ok: false, error: "unknown_method" });
    }
  };

  readonly webSocket = (url: string): FakeSocket => {
    const s = new FakeSocket(url);
    this.sockets.push(s);
    // Slack greets every new connection.
    queueMicrotask(() => s.push({ type: "hello", num_connections: 1 }));
    return s;
  };

  get socket(): FakeSocket {
    const s = this.sockets.at(-1);
    if (s === undefined) throw new Error("no socket yet");
    return s;
  }

  /** Posted messages (`chat.postMessage`). */
  posts(): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === "chat.postMessage").map((c) => c.body);
  }

  /** Pushes an Events API envelope and returns its id. */
  event(event: Record<string, unknown>): string {
    const id = `env-${++this.#envelope}`;
    this.socket.push({ envelope_id: id, type: "events_api", payload: { event } });
    return id;
  }

  /** A DM from `user` in their DM channel `D<user>`. */
  dm(user: string, text: string, extra: Record<string, unknown> = {}): string {
    return this.event({
      type: "message",
      channel: `D${user}`,
      channel_type: "im",
      user,
      text,
      ts: `${++this.#ts}.000200`,
      ...extra,
    });
  }

  /** A button click on a card. */
  click(user: string, channel: string, messageTs: string, actionId: string, value: string): string {
    const id = `env-${++this.#envelope}`;
    this.socket.push({
      envelope_id: id,
      type: "interactive",
      payload: {
        type: "block_actions",
        user: { id: user },
        channel: { id: channel },
        message: { ts: messageTs },
        actions: [{ action_id: actionId, value }],
      },
    });
    return id;
  }

  acked(): string[] {
    return this.sockets.flatMap((s) =>
      s.sent.map((m) => (m as { envelope_id?: string }).envelope_id ?? ""),
    );
  }
}
