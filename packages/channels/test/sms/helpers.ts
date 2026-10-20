import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SmsAdapter, type SmsAdapterOptions } from "../../src/adapters/sms/adapter.ts";
import { twilioSignature } from "../../src/adapters/sms/mapping.ts";

export const SID = "AC_TEST_ACCOUNT_SID_NOT_REAL";
export const TOKEN = "tok_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
export const PSYCHE = "+15550009999";
export const OWNER = "+15550001111";
export const FRIEND = "+15550002222";
export const STRANGER = "+15550003333";
export const PUBLIC_URL = "https://psyche.example.test/channels/sms/twilio";

export interface TwilioRequest {
  method: string;
  path: string;
  auth: string;
  form: URLSearchParams;
}

/** Localhost stand-in for the Twilio REST API: records requests, answers from a queue. */
export class FakeTwilio {
  readonly requests: TwilioRequest[] = [];
  readonly replies: { status: number; body: unknown; headers?: Record<string, string> }[] = [];
  #server: Server = createServer((req, res) => void this.#handle(req, res));
  #seq = 0;
  base = "";

  async listen(): Promise<this> {
    await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  close(): Promise<void> {
    this.#server.closeAllConnections();
    return new Promise((r) => this.#server.close(() => r()));
  }

  sent(): string[] {
    return this.requests
      .filter((r) => r.path.endsWith("/Messages.json"))
      .map((r) => r.form.get("Body") ?? "");
  }

  async #handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    this.requests.push({
      method: req.method ?? "",
      path: req.url ?? "",
      auth: req.headers.authorization ?? "",
      form: new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
    });
    const next = this.replies.shift() ?? { status: 201, body: { sid: `SM${++this.#seq}` } };
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    res.writeHead(next.status, { "content-type": "application/json", ...next.headers });
    res.end(body);
  }
}

export function adapter(api: FakeTwilio, extra: Partial<SmsAdapterOptions> = {}): SmsAdapter {
  return new SmsAdapter({
    accountSid: SID,
    authToken: { use: (fn) => fn(TOKEN) },
    from: PSYCHE,
    publicUrl: PUBLIC_URL,
    apiBase: api.base,
    ...extra,
  });
}

let sidSeq = 0;
export function inbound(fields: Record<string, string> = {}): Record<string, string> {
  return {
    AccountSid: SID,
    MessageSid: `SM${(++sidSeq).toString(16).padStart(32, "0")}`,
    From: FRIEND,
    To: PSYCHE,
    Body: "hello",
    NumMedia: "0",
    ...fields,
  };
}

/** A signed webhook request for `fields` (signature over `url`, default the public URL). */
export function signed(
  fields: Record<string, string>,
  options: { url?: string; token?: string } = {},
): { url: string; headers: Record<string, string>; body: string } {
  const body = new URLSearchParams(fields).toString();
  const sig = twilioSignature(
    options.token ?? TOKEN,
    options.url ?? PUBLIC_URL,
    Object.entries(fields),
  );
  return { url: "/channels/sms/twilio", headers: { "x-twilio-signature": sig }, body };
}
