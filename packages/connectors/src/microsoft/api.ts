import { PsycheError } from "@psyche/protocol";
import type { FetchFn } from "../framework/types.ts";
import type { MicrosoftAuth } from "./auth.ts";

export const GRAPH_ORIGIN = "https://graph.microsoft.com";
export const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;

export interface GraphRequest {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body, or raw bytes / text with `contentType`. */
  json?: unknown;
  body?: string | Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Graph's error status, for callers that branch on it (410 resync, 404). */
export class GraphError extends PsycheError {
  readonly status: number;
  readonly graphCode: string;
  constructor(status: number, graphCode: string) {
    const code =
      status === 404
        ? "not_found"
        : status === 403
          ? "forbidden"
          : status === 409
            ? "conflict"
            : status === 429
              ? "rate_limited"
              : status === 400
                ? "invalid_params"
                : "unavailable";
    super(code, `Microsoft Graph returned ${status}${graphCode === "" ? "" : ` (${graphCode})`}`, {
      details: { status, graphCode },
      retryable: status === 429 || status >= 500,
    });
    this.status = status;
    this.graphCode = graphCode;
  }
}

/**
 * Microsoft Graph v1.0 over the connector's `fetch`. The bearer token goes only to
 * `https://graph.microsoft.com`: paging links are checked to stay there, and redirects (file
 * downloads) are returned to the caller unfollowed, so a pre-authenticated download URL is
 * fetched without the token.
 */
export class GraphApi {
  readonly #auth: MicrosoftAuth;
  readonly #fetch: FetchFn;

  constructor(auth: MicrosoftAuth, fetch: FetchFn) {
    this.#auth = auth;
    this.#fetch = fetch;
  }

  url(pathOrUrl: string, query?: GraphRequest["query"]): URL {
    const url = pathOrUrl.startsWith("https://")
      ? new URL(pathOrUrl)
      : new URL(`${GRAPH_BASE}${pathOrUrl}`);
    if (url.origin !== GRAPH_ORIGIN) {
      throw new PsycheError("policy_denied", `refusing to send the Microsoft token to ${url.host}`);
    }
    for (const [k, v] of Object.entries(query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    return url;
  }

  /** One Graph request with the bearer token; a 401 refreshes once and retries. */
  async request(pathOrUrl: string, req: GraphRequest = {}): Promise<Response> {
    const url = this.url(pathOrUrl, req.query);
    const send = async (force: boolean) => {
      const token = await this.#auth.accessToken(req.signal, force);
      const headers = new Headers(req.headers);
      headers.set("authorization", `Bearer ${token}`);
      let body: string | ArrayBuffer | undefined;
      if (req.json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(req.json);
      } else if (req.body !== undefined) {
        headers.set("content-type", req.contentType ?? "application/octet-stream");
        body =
          typeof req.body === "string"
            ? req.body
            : (req.body.buffer.slice(
                req.body.byteOffset,
                req.body.byteOffset + req.body.byteLength,
              ) as ArrayBuffer);
      }
      return this.#fetch(url, {
        method: req.method ?? "GET",
        headers,
        redirect: "manual",
        ...(body === undefined ? {} : { body }),
        ...(req.signal === undefined ? {} : { signal: req.signal }),
      });
    };
    let res = await send(false);
    if (res.status === 401) res = await send(true);
    if (res.status >= 300 && res.status < 400) return res;
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { code?: unknown } };
      throw new GraphError(
        res.status,
        typeof err.error?.code === "string" ? err.error.code.slice(0, 80) : "",
      );
    }
    return res;
  }

  async json<T>(pathOrUrl: string, req: GraphRequest = {}): Promise<T> {
    const res = await this.request(pathOrUrl, {
      ...req,
      headers: { accept: "application/json", ...req.headers },
    });
    if (res.status === 202 || res.status === 204) return {} as T;
    return (await res.json()) as T;
  }

  async text(pathOrUrl: string, req: GraphRequest = {}): Promise<string> {
    return (await this.request(pathOrUrl, req)).text();
  }

  /** A pre-authenticated download URL from a Graph redirect: fetched without the token. */
  async download(location: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    const url = new URL(location);
    if (url.protocol !== "https:")
      throw new PsycheError("policy_denied", "download URL is not https");
    const res = await this.#fetch(url, {
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!res.ok) throw new GraphError(res.status, "");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes)
      throw new PsycheError("invalid_params", "file is larger than the limit");
    return bytes;
  }
}

/** `'` doubled for OData string literals. */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** An ISO instant as Graph's `dateTimeTimeZone` in UTC. */
export function utcDateTime(iso: string): { dateTime: string; timeZone: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    throw new PsycheError("invalid_params", `not a date-time: ${iso.slice(0, 40)}`);
  return { dateTime: d.toISOString().replace(/Z$/, ""), timeZone: "UTC" };
}
