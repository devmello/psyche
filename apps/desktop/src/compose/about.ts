import { type AboutInfo, t } from "@psyche/ui";
import { useEffect, useState } from "react";
import type { AppInfoPort, HostAppInfo } from "../shell/platform.ts";

/**
 * Settings → About versions. The app version is baked in at build time (the workspace versions
 * every package together, so it is the desktop's too); the Gateway reports its own and the
 * protocol's at `GET /version` on the same origin (the desktop loads the UI from the Gateway, and
 * `pnpm dev` proxies it), so no protocol method is needed.
 */
export interface VersionResponse {
  name?: unknown;
  version?: unknown;
  protocolVersion?: unknown;
}

export const APP_VERSION: string =
  typeof __PSYCHE_APP_VERSION__ === "string" ? __PSYCHE_APP_VERSION__ : "";

/** The About card's data from `/version`'s body (or nothing, when it could not be fetched). */
export function aboutInfoFrom(body: VersionResponse | null, appVersion = APP_VERSION): AboutInfo {
  const unknown = t("settings.about.unknown");
  const protocol =
    typeof body?.protocolVersion === "number"
      ? body.protocolVersion
      : Number.parseInt(String(body?.protocolVersion ?? ""), 10);
  return {
    appVersion: appVersion || unknown,
    gatewayVersion: typeof body?.version === "string" && body.version ? body.version : unknown,
    protocolVersion: Number.isFinite(protocol) ? protocol : 1,
    platform: typeof navigator === "undefined" ? "" : navigator.platform || "web",
    home: "",
  };
}

export async function fetchVersion(fetchFn: typeof fetch = fetch): Promise<VersionResponse | null> {
  try {
    const res = await fetchFn("/version", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as VersionResponse;
  } catch {
    return null;
  }
}

// i18n-ignore-start: operating system names
const OS_NAMES: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };
// i18n-ignore-end

/**
 * "Apple silicon" or "Intel" for a Mac's `process.arch`; "Arm64" or "x64" for a PC's (Windows
 * names its architectures so); anything else as reported.
 */
export function archLabel(arch: string, platform = "darwin"): string {
  if (platform === "win32") {
    if (arch === "arm64") return t("web.about.windowsArm");
    if (arch === "x64") return t("web.about.windowsX64");
    return arch;
  }
  if (arch === "arm64") return t("web.about.appleSilicon");
  if (arch === "x64") return t("web.about.intel");
  return arch;
}

/**
 * Windows reports its version as the NT kernel's ("10.0.26200" on Windows 11 too); the owner
 * knows it as Windows 10 or 11 and a build number. Windows 11 starts at build 22000.
 */
function windowsVersion(osVersion: string): { os: string; version: string } {
  const build = /^10\.0\.(\d+)/.exec(osVersion)?.[1];
  if (build === undefined) return { os: "Windows", version: osVersion };
  return {
    // i18n-ignore: Windows product names
    os: Number(build) >= 22000 ? "Windows 11" : "Windows 10",
    version: t("web.about.windowsBuild", { build }),
  };
}

/**
 * "macOS 27.0.1 · Apple silicon" (`navigator.platform` says "MacIntel" on every Mac), or
 * "Windows 11 build 26200 · x64".
 */
export function platformLabel(host: Pick<HostAppInfo, "platform" | "osVersion" | "arch">): string {
  const { os, version } =
    host.platform === "win32"
      ? windowsVersion(host.osVersion)
      : { os: OS_NAMES[host.platform] ?? host.platform, version: host.osVersion };
  return t("web.about.platform", { os, version, arch: archLabel(host.arch, host.platform) }).trim();
}

/**
 * The desktop's About (#610): everything comes from main over the bridge, including the
 * Gateway's `/version` (fetched from its origin there; the renderer's CSP is `connect-src 'self'`).
 * The baked version is the fallback when main reports none.
 */
export function aboutInfoFromHost(host: HostAppInfo, fallbackVersion = APP_VERSION): AboutInfo {
  const base = aboutInfoFrom(host.gateway, host.appVersion || fallbackVersion);
  return {
    ...base,
    platform: platformLabel(host),
    home: host.psycheHome,
    ...(host.electronVersion
      ? {
          runtime: t("web.about.runtime", {
            electron: host.electronVersion,
            chrome: host.chromeVersion,
          }),
        }
      : {}),
  };
}

/**
 * Resolves once per mount; shows the app version at once and the rest when it answers. The
 * desktop asks its main process (`app`); the web fetches `/version` on its own origin.
 */
export function useAboutInfo(app?: AppInfoPort): AboutInfo {
  const [info, setInfo] = useState<AboutInfo>(() => aboutInfoFrom(null));
  useEffect(() => {
    let live = true;
    if (app) {
      void app.info().then(
        (host) => {
          if (live) setInfo(aboutInfoFromHost(host));
        },
        () => undefined,
      );
    } else {
      void fetchVersion().then((body) => {
        if (live && body) setInfo(aboutInfoFrom(body));
      });
    }
    return () => {
      live = false;
    };
  }, [app]);
  return info;
}
