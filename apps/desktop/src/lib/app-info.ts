/**
 * Settings → About on the desktop (#610). The renderer is its own bundle served from
 * app://psyche, so it has neither the web build's baked version nor a same-origin `/version`;
 * main answers both. Main fetches the Gateway's `/version` because the renderer's CSP allows
 * only `connect-src 'self'` and the Gateway sends no CORS headers.
 */

export interface GatewayVersion {
  name?: unknown;
  version?: unknown;
  protocolVersion?: unknown;
}

export interface AppInfo {
  appVersion: string;
  /** `process.platform`: "darwin" in practice. */
  platform: string;
  /** `process.arch`: "arm64" (Apple silicon) or "x64" (Intel). */
  arch: string;
  /** `process.getSystemVersion()`, e.g. "27.0.1". */
  osVersion: string;
  electronVersion: string;
  chromeVersion: string;
  /** PSYCHE_HOME or the default `~/.psyche`. */
  psycheHome: string;
  /** The Gateway's HTTP origin, e.g. "http://127.0.0.1:18789". */
  gatewayOrigin: string;
  /** The Gateway's `/version` answer, or null when it did not answer. */
  gateway: GatewayVersion | null;
}

export interface AppInfoDeps {
  appVersion: string;
  platform: string;
  arch: string;
  osVersion: string;
  versions: { electron?: string; chrome?: string };
  psycheHome: string;
  gatewayOrigin: string;
  fetch?: typeof fetch;
}

export async function fetchGatewayVersion(
  origin: string,
  fetchFn: typeof fetch = fetch,
): Promise<GatewayVersion | null> {
  try {
    const res = await fetchFn(new URL("/version", origin), {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return (await res.json()) as GatewayVersion;
  } catch {
    return null;
  }
}

export async function appInfo(deps: AppInfoDeps): Promise<AppInfo> {
  return {
    appVersion: deps.appVersion,
    platform: deps.platform,
    arch: deps.arch,
    osVersion: deps.osVersion,
    electronVersion: deps.versions.electron ?? "",
    chromeVersion: deps.versions.chrome ?? "",
    psycheHome: deps.psycheHome,
    gatewayOrigin: deps.gatewayOrigin,
    gateway: await fetchGatewayVersion(deps.gatewayOrigin, deps.fetch),
  };
}
