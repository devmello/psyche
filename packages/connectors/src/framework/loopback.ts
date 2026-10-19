import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PsycheError } from "@psyche/protocol";

/**
 * Installed-app OAuth helpers (RFC 8252 / RFC 7636): a loopback receiver on
 * `127.0.0.1:<random port>/callback` that accepts exactly one callback with the expected
 * `state`, and PKCE S256 pairs. Used by the Google connector (and later Microsoft).
 */
export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function createPkce(): Pkce {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

export function randomState(): string {
  return randomBytes(24).toString("base64url");
}

export interface LoopbackReceiver {
  readonly redirectUri: string;
  /** Resolves with the callback query once a request with `state === expected` arrives. */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<URLSearchParams>;
  close(): Promise<void>;
}

const PAGE_OK =
  "<!doctype html><meta charset=utf-8><title>Psyche</title><p>Signed in. You can close this window.";
const PAGE_BAD =
  "<!doctype html><meta charset=utf-8><title>Psyche</title><p>Invalid sign-in callback.";

export async function startLoopback(
  expectedState: string,
  path = "/callback",
): Promise<LoopbackReceiver> {
  let result: URLSearchParams | undefined;
  let notify: (() => void) | undefined;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== path) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    // Wrong or missing state: ignore (CSRF, stale tab) and keep waiting.
    const ok = result === undefined && url.searchParams.get("state") === expectedState;
    if (ok) {
      result = url.searchParams;
      notify?.();
    }
    res
      .writeHead(ok ? 200 : 400, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(ok ? PAGE_OK : PAGE_BAD);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${port}${path}`,
    wait(timeoutMs, signal) {
      return new Promise((resolve, reject) => {
        const finish = (err?: PsycheError) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          notify = undefined;
          if (err !== undefined) return reject(err);
          const params = result as URLSearchParams;
          // error_description is attacker-influenced; report the error code only.
          if (params.has("error")) {
            return reject(
              new PsycheError("unauthorized", `authorization failed: ${params.get("error")}`),
            );
          }
          resolve(params);
        };
        const onAbort = () => finish(new PsycheError("cancelled", "authorization cancelled"));
        const timer = setTimeout(
          () => finish(new PsycheError("timeout", "authorization was not completed in time")),
          timeoutMs,
        );
        if (signal?.aborted === true) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        if (result !== undefined) return finish();
        notify = () => finish();
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
