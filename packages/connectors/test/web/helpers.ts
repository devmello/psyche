import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PsycheError } from "@psyche/protocol";
import { expect } from "vitest";
import type {
  DnsLookup,
  PinnedRequest,
  ResolvedAddress,
  Transport,
  TransportResponse,
} from "../../src/web/fetch.ts";

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

export function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

/** Fake DNS: a static table; records every name asked. */
export function fakeLookup(table: Record<string, string | string[]>): DnsLookup & {
  calls: string[];
} {
  const calls: string[] = [];
  const fn = async (hostname: string): Promise<ResolvedAddress[]> => {
    calls.push(hostname);
    const entry = table[hostname];
    if (entry === undefined) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    const list = Array.isArray(entry) ? entry : [entry];
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return Object.assign(fn, { calls });
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array | Uint8Array[];
  /** Never answer (until aborted). */
  hang?: boolean;
}

/** Fake transport keyed by full URL; records each pinned request. */
export function fakeTransport(
  routes: Record<string, FakeReply | ((req: PinnedRequest) => FakeReply)>,
): Transport & {
  calls: PinnedRequest[];
} {
  const calls: PinnedRequest[] = [];
  const fn = async (req: PinnedRequest): Promise<TransportResponse> => {
    calls.push(req);
    const route = routes[req.url.toString()];
    if (route === undefined) throw new Error(`no route for ${req.url.toString()}`);
    const reply = typeof route === "function" ? route(req) : route;
    if (reply.hang === true) {
      return new Promise((_resolve, reject) => {
        req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    const raw = reply.body ?? "";
    const chunks =
      typeof raw === "string"
        ? [new TextEncoder().encode(raw)]
        : raw instanceof Uint8Array
          ? [raw]
          : raw;
    let closed = false;
    return {
      status: reply.status ?? 200,
      headers: Object.fromEntries(
        Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body: (async function* () {
        for (const c of chunks) {
          if (closed) return;
          yield c;
        }
      })(),
      close: () => {
        closed = true;
      },
    };
  };
  return Object.assign(fn, { calls });
}

export async function startServer(
  handler: http.RequestListener,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Assert `p` rejects with a PsycheError of `code` (and `reason` in details, when given). */
export async function expectPsyche(
  p: Promise<unknown>,
  code: string,
  reason?: string,
): Promise<PsycheError> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(PsycheError);
  const e = caught as PsycheError;
  expect(e.code).toBe(code);
  if (reason !== undefined) expect((e.details as { reason?: string }).reason).toBe(reason);
  return e;
}
