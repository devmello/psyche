import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_GATEWAY_HOST, DEFAULT_GATEWAY_PORT } from "@psyche/protocol";
import { CliError } from "./errors.ts";

/** `$PSYCHE_HOME` (architecture §12): `--home`, then the environment, then `~/.psyche`. */
export function resolveHome(env: NodeJS.ProcessEnv, flag?: string): string {
  return resolve(flag ?? env.PSYCHE_HOME ?? join(homedir(), ".psyche"));
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

/**
 * The Gateway's HTTP origin. `--url`, then `PSYCHE_URL`, then `http://127.0.0.1:$PSYCHE_PORT`.
 * Only http(s) is accepted, and plain http only to a loopback host (an SSH tunnel counts):
 * transcripts and vault metadata must not cross a network unencrypted (security §10).
 */
export function resolveGatewayUrl(
  env: NodeJS.ProcessEnv,
  flag?: string,
  opts: { insecure?: boolean } = {},
): URL {
  const raw =
    flag ??
    env.PSYCHE_URL ??
    `http://${DEFAULT_GATEWAY_HOST}:${env.PSYCHE_PORT ?? String(DEFAULT_GATEWAY_PORT)}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError("usage", `Not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError("usage", `Gateway URL must be http:// or https://, got ${url.protocol}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError("usage", "Gateway URL must not carry credentials, a query or a fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && !opts.insecure) {
    throw new CliError(
      "usage",
      `Refusing plain http to ${url.hostname}. Use https (Tailscale Serve, Cloudflare Access) or an SSH tunnel to 127.0.0.1, or pass --insecure.`,
    );
  }
  url.pathname = "/";
  return url;
}

export function wsUrl(base: URL): string {
  const u = new URL("/ws", base);
  u.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}
