import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PsycheError } from "@psyche/protocol";

/**
 * RFC 8252 loopback redirect receiver: listens on `127.0.0.1:<random port>/callback` (never on
 * other interfaces) and accepts exactly one callback whose `state` matches the expected value.
 * It is armed as soon as it listens, so a callback that arrives before `wait()` is kept.
 */
export interface LoopbackReceiver {
  readonly redirectUrl: string;
  /** Resolves with the callback's query once a request with the expected `state` arrived. */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<URLSearchParams>;
  close(): Promise<void>;
}

const PAGE_OK =
  "<!doctype html><meta charset=utf-8><title>Psyche</title><p>Signed in. You can close this window.";
const PAGE_BAD =
  "<!doctype html><meta charset=utf-8><title>Psyche</title><p>Invalid sign-in callback.";

export async function startLoopbackReceiver(
  expectedState: () => string | undefined,
  path = "/callback",
): Promise<LoopbackReceiver> {
  let result: { params: URLSearchParams } | undefined;
  let notify: (() => void) | undefined;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== path) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const expected = expectedState();
    // A callback with the wrong state is ignored (CSRF / stale tab); the receiver keeps waiting.
    const accepted =
      result === undefined && expected !== undefined && url.searchParams.get("state") === expected;
    if (accepted) {
      result = { params: url.searchParams };
      notify?.();
    }
    res
      .writeHead(accepted ? 200 : 400, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(accepted ? PAGE_OK : PAGE_BAD);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const settle = (params: URLSearchParams): URLSearchParams => {
    // error_description is attacker-influenced in a mix-up attack; report the code only.
    if (params.has("error")) {
      throw new PsycheError("unauthorized", `authorization failed: ${params.get("error")}`);
    }
    return params;
  };
  return {
    redirectUrl: `http://127.0.0.1:${port}${path}`,
    wait(timeoutMs, signal) {
      return new Promise<URLSearchParams>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          notify = undefined;
          try {
            resolve(settle((result as { params: URLSearchParams }).params));
          } catch (err) {
            reject(err);
          }
        };
        const onAbort = () => {
          clearTimeout(timer);
          notify = undefined;
          reject(new PsycheError("cancelled", "authorization cancelled"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          notify = undefined;
          reject(new PsycheError("timeout", "authorization was not completed in time"));
        }, timeoutMs);
        if (signal?.aborted === true) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        if (result !== undefined) return done();
        notify = done;
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
