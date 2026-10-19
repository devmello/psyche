import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A recorded HTTP exchange. `body` is the raw response body: SSE text for Anthropic, OpenAI,
 * OpenRouter and the OpenAI-compatible servers, NDJSON for Ollama native, JSON for errors and
 * embeddings. `chunks` splits it the way the network delivered it (optional).
 */
export interface Fixture {
  name?: string;
  request: { method?: string; pathEndsWith: string };
  response: {
    status: number;
    headers?: Record<string, string>;
    body?: string;
    chunks?: string[];
    /** Stop sending after the chunks and keep the connection open (cancellation tests). */
    hang?: boolean;
  };
}

export interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

export function loadFixture(path: string): Fixture {
  return JSON.parse(readFileSync(resolve(FIXTURES, path), "utf8")) as Fixture;
}

/**
 * `fetch` that answers each request with the next fixture and records what was sent, so tests
 * assert on the real wire request the provider package built. No network.
 */
export function replayFetch(...fixtures: Fixture[]) {
  const queue = [...fixtures];
  const requests: Captured[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep the string
      }
    }
    requests.push({ url, method: init?.method ?? "GET", headers, body });
    const fx = queue.shift();
    if (fx === undefined) throw new Error(`replayFetch: no fixture left for ${url}`);
    if (!new URL(url).pathname.endsWith(fx.request.pathEndsWith)) {
      throw new Error(`replayFetch: ${url} does not end with ${fx.request.pathEndsWith}`);
    }
    const chunks = fx.response.chunks ?? (fx.response.body === undefined ? [] : [fx.response.body]);
    const signal = init?.signal ?? undefined;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const c of chunks) {
          if (signal?.aborted === true) break;
          controller.enqueue(enc.encode(c));
          await new Promise((r) => setTimeout(r, 0));
        }
        if (fx.response.hang === true) {
          signal?.addEventListener("abort", () => {
            try {
              controller.error(new DOMException("aborted", "AbortError"));
            } catch {
              // already closed
            }
          });
          return;
        }
        controller.close();
      },
    });
    if (signal?.aborted === true) throw new DOMException("aborted", "AbortError");
    return new Response(stream, {
      status: fx.response.status,
      headers: { "content-type": "text/event-stream", ...fx.response.headers },
    });
  };
  return { fetch: fetchFn as typeof fetch, requests, remaining: () => queue.length };
}

/** Build an SSE body from `[event, data]` pairs (`event` null for data-only streams). */
export function sse(events: [string | null, unknown][], done = false): string {
  const lines = events.map(([event, data]) => {
    const d = typeof data === "string" ? data : JSON.stringify(data);
    return event === null ? `data: ${d}\n\n` : `event: ${event}\ndata: ${d}\n\n`;
  });
  if (done) lines.push("data: [DONE]\n\n");
  return lines.join("");
}
