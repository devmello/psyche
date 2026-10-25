import { type AboutInfo, t } from "@psyche/ui";
import { useEffect, useState } from "react";

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

/** Resolves once per mount; shows the app version at once and the Gateway's when it answers. */
export function useAboutInfo(): AboutInfo {
  const [info, setInfo] = useState<AboutInfo>(() => aboutInfoFrom(null));
  useEffect(() => {
    let live = true;
    void fetchVersion().then((body) => {
      if (live && body) setInfo(aboutInfoFrom(body));
    });
    return () => {
      live = false;
    };
  }, []);
  return info;
}
