import { PsycheError } from "@psyche/protocol";
import type { FetchFn } from "../framework/types.ts";
import type { GoogleAuth } from "./auth.ts";

/** Upper bound on a JSON response body read from Google (a thread with huge inline parts). */
export const MAX_JSON_BYTES = 32 * 1024 * 1024;

export interface GoogleRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | string[] | undefined>;
  json?: unknown;
  body?: RequestInit["body"];
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Google REST errors as PsycheError, keeping the HTTP status for sync logic (404 / 410). */
export function googleError(
  status: number,
  reason: string | undefined,
  where: string,
): PsycheError {
  const details = { status, reason: reason ?? null };
  const msg = `Google ${where} failed: ${status}${reason === undefined ? "" : ` ${reason}`}`;
  if (status === 404) return new PsycheError("not_found", msg, { details });
  if (status === 410 || status === 409 || status === 412)
    return new PsycheError("conflict", msg, { details });
  if (status === 401) return new PsycheError("unauthorized", msg, { details });
  if (status === 403 && (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded")) {
    return new PsycheError("rate_limited", msg, { details, retryable: true });
  }
  if (status === 403) return new PsycheError("forbidden", msg, { details });
  if (status === 429) return new PsycheError("rate_limited", msg, { details, retryable: true });
  if (status === 400) return new PsycheError("invalid_params", msg, { details });
  if (status >= 500) return new PsycheError("unavailable", msg, { details, retryable: true });
  return new PsycheError("internal", msg, { details });
}

export function statusOf(err: unknown): number | undefined {
  if (!(err instanceof PsycheError)) return undefined;
  const d = err.details as { status?: unknown } | undefined;
  return typeof d?.status === "number" ? d.status : undefined;
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > max) throw new PsycheError("invalid_params", "Google response too large");
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new PsycheError("invalid_params", "Google response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Authorized calls to Google REST APIs; one 401 triggers a forced token refresh and a retry. */
export class GoogleApi {
  readonly #auth: GoogleAuth;
  readonly #fetch: FetchFn;

  constructor(auth: GoogleAuth, fetch: FetchFn) {
    this.#auth = auth;
    this.#fetch = fetch;
  }

  async json<T>(url: string, req: GoogleRequest = {}): Promise<T> {
    const res = await this.#send(url, req);
    const bytes = await readCapped(res, MAX_JSON_BYTES);
    if (bytes.byteLength === 0) return {} as T;
    try {
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
    } catch {
      throw new PsycheError("internal", "Google returned malformed JSON");
    }
  }

  /** Raw bytes (Drive `alt=media`), capped. */
  async bytes(
    url: string,
    max: number,
    req: GoogleRequest = {},
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.#send(url, req);
    return {
      bytes: await readCapped(res, max),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async #send(url: string, req: GoogleRequest): Promise<Response> {
    const u = new URL(url);
    if (u.protocol !== "https:" || !u.hostname.endsWith("googleapis.com")) {
      throw new PsycheError("forbidden", "Google API calls go only to googleapis.com");
    }
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, x);
      else u.searchParams.set(k, String(v));
    }
    const attempt = async (force: boolean) => {
      const token = await this.#auth.accessToken(req.signal, force);
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...req.headers,
      };
      let body = req.body;
      if (req.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(req.json);
      }
      return this.#fetch(u, {
        method: req.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
        ...(req.signal === undefined ? {} : { signal: req.signal }),
        redirect: "error",
      });
    };
    let res = await attempt(false);
    if (res.status === 401) res = await attempt(true);
    if (!res.ok) {
      let reason: string | undefined;
      try {
        const j = (await res.json()) as {
          error?: { errors?: { reason?: string }[]; status?: string };
        };
        reason = j.error?.errors?.[0]?.reason ?? j.error?.status;
      } catch {
        // non-JSON error body
      }
      throw googleError(res.status, reason, `${req.method ?? "GET"} ${u.pathname}`);
    }
    return res;
  }
}
