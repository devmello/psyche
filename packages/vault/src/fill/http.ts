import type { CredentialBroker, PsycheError } from "@psyche/protocol";
import { canonicalOrigin } from "../binding.ts";
import { fail } from "../errors.ts";

export interface AuthorizedFetchInput {
  broker: CredentialBroker;
  /** Usually `{{cred:<slug>.header}}` (prefix + token) or `{{cred:<slug>.token}}`. */
  placeholder: string;
  approvalId: string;
  url: string;
  /** Header carrying the value (`Authorization`, `X-Api-Key`). */
  headerName: string;
  init?: Omit<RequestInit, "redirect">;
  fetchImpl?: typeof fetch;
  /** Same-origin redirects followed with the header (default 5). */
  maxRedirects?: number;
  taskId?: string;
}

export interface AuthorizedFetchResult {
  response: Response;
  /**
   * Set when the server redirected to another origin. The redirect was NOT followed and the
   * credential was not sent there; going on is a new-origin decision for the caller.
   */
  crossOriginRedirect?: { origin: string | null; status: number };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Connector HTTP with a vault credential (security §4.6, S23 design-16): HTTPS only; the header
 * is added for the bound host only; redirects are handled manually and the header goes only to
 * same-origin hops (undici strips `authorization` but not custom headers like `X-Api-Key`);
 * scheme downgrades and cross-origin hops are returned unfollowed. Network errors are rebuilt
 * without the request, so no header can ride along in an error object.
 */
export async function authorizedFetch(input: AuthorizedFetchInput): Promise<AuthorizedFetchResult> {
  const doFetch = input.fetchImpl ?? fetch;
  let url = new URL(input.url);
  if (url.protocol !== "https:")
    return fail("policy_denied", "credentials go over HTTPS only", { reason: "not_https" });
  const origin = url.origin;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(input.headerName)) {
    return fail("invalid_params", "invalid header name");
  }
  const handle = await input.broker.resolve(
    input.placeholder,
    { kind: "origin", value: origin },
    input.approvalId,
    { executor: "connector", ...(input.taskId === undefined ? {} : { taskId: input.taskId }) },
  );
  const headers = new Headers(input.init?.headers);
  if (headers.has(input.headerName))
    return fail("invalid_params", "header already set by the caller");
  handle.use((value) => headers.set(input.headerName, value));
  let method = (input.init?.method ?? "GET").toUpperCase();
  let body = input.init?.body;
  try {
    for (let hop = 0; ; hop += 1) {
      let response: Response;
      try {
        response = await doFetch(url, {
          ...input.init,
          method,
          headers,
          ...(body === undefined || body === null ? {} : { body }),
          redirect: "manual",
        });
      } catch (err) {
        const code =
          (err as { cause?: { code?: string }; name?: string }).cause?.code ?? (err as Error).name;
        return fail("unavailable", `request to ${origin} failed (${code ?? "error"})`, {
          reason: "network",
        });
      }
      if (!REDIRECTS.has(response.status)) return { response };
      const location = response.headers.get("location");
      if (location === null) return { response };
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return { response, crossOriginRedirect: { origin: null, status: response.status } };
      }
      if (
        next.protocol !== "https:" ||
        next.origin !== origin ||
        hop >= (input.maxRedirects ?? 5)
      ) {
        await response.body?.cancel().catch(() => undefined);
        return {
          response,
          crossOriginRedirect: { origin: canonicalOrigin(next.href), status: response.status },
        };
      }
      await response.body?.cancel().catch(() => undefined);
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
      }
      url = next;
    }
  } finally {
    headers.delete(input.headerName);
  }
}

/** The only error shape that may cross an executor boundary (S23 design-16). */
export interface SafeHttpError {
  status: number | null;
  code: string;
  providerMessage: string;
}

/**
 * Rebuild an error from an allowlisted shape: never `config`, `options`, `request`, `headers` or
 * `requestBodyValues`; the provider's message passes through `redact` (keys echoed back).
 */
export function safeHttpError(err: unknown, redact: (text: string) => string): SafeHttpError {
  const e = (err ?? {}) as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    code?: unknown;
    message?: unknown;
  };
  const status =
    typeof e.status === "number"
      ? e.status
      : typeof e.statusCode === "number"
        ? e.statusCode
        : typeof e.response?.status === "number"
          ? e.response.status
          : null;
  const code =
    typeof e.code === "string" ? e.code : ((err as PsycheError | undefined)?.name ?? "error");
  const message = typeof e.message === "string" ? e.message.slice(0, 500) : "";
  return { status, code: redact(code), providerMessage: redact(message) };
}

/** Read a response body as text with every vault value masked (providers echo keys). */
export async function redactedText(
  response: Response,
  redact: (text: string) => string,
): Promise<string> {
  return redact(await response.text());
}
