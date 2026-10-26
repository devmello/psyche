import type { ArtifactMap, ArtifactMapMarker } from "@psyche/protocol";

/**
 * Pure helpers for the map widget: parsing the artifact's JSON, the tile-source settings and the
 * view box. Nothing here touches MapLibre, so the list fallback and the tests never load it.
 */

export const MAP_TILES_KEY = "ui.map.tiles";
export const MAP_STYLE_KEY = "ui.map.styleUrl";
export const MAP_STYLE_DARK_KEY = "ui.map.styleUrlDark";

/** OpenFreeMap: free vector tiles from OpenStreetMap data, no key and no sign-up. */
export const DEFAULT_STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
export const DEFAULT_STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";

export interface MapSource {
  /** `false`: never request tiles; the map is the list only. */
  tiles: boolean;
  light: string;
  dark: string;
  /** The tile server is the default public one (the Settings note says who sees what). */
  isDefault: boolean;
}

/** A style URL we will fetch: https anywhere, http only for a local or private tile server. */
export function validStyleUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol === "https:") return u.href;
    const local = u.hostname === "localhost" || u.hostname.endsWith(".local");
    return u.protocol === "http:" && (local || /^(127|10)\./.test(u.hostname)) ? u.href : null;
  } catch {
    return null;
  }
}

export function mapSourceOf(settings: Readonly<Record<string, unknown>>): MapSource {
  const custom = validStyleUrl(settings[MAP_STYLE_KEY]);
  const customDark = validStyleUrl(settings[MAP_STYLE_DARK_KEY]);
  return {
    tiles: settings[MAP_TILES_KEY] !== false,
    light: custom ?? DEFAULT_STYLE_LIGHT,
    dark: customDark ?? custom ?? DEFAULT_STYLE_DARK,
    isDefault: custom === null,
  };
}

/** The route the Gateway serves tiles from (`apps/gateway/src/map-proxy.ts`). */
export const MAP_PROXY_PATH = "/maps/o/";

/**
 * Rewrites a MapLibre request to the Gateway's same-origin tile proxy, so the page's CSP never has
 * to name a tile host and the tile host sees the Gateway, not the viewer. Same-origin and non-http
 * URLs pass through. Used as MapLibre's `transformRequest`.
 */
export function proxiedUrl(url: string, pageOrigin: string): string {
  let u: URL;
  try {
    u = new URL(url, pageOrigin);
  } catch {
    return url;
  }
  if (u.origin === pageOrigin || (u.protocol !== "https:" && u.protocol !== "http:")) return url;
  const seg = btoa(u.origin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${pageOrigin}${MAP_PROXY_PATH}${seg}${u.pathname}${u.search}`;
}

/** Parses a map artifact's content; null when it is not a usable map. */
export function parseMapContent(content: string): ArtifactMap | null {
  let v: unknown;
  try {
    v = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const m = v as Partial<ArtifactMap>;
  if (!Array.isArray(m.markers)) return null;
  const markers = m.markers.filter(
    (p): p is ArtifactMapMarker =>
      typeof p === "object" &&
      p !== null &&
      typeof p.id === "string" &&
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lng) &&
      Math.abs(p.lat) <= 90 &&
      Math.abs(p.lng) <= 180,
  );
  return { ...m, markers } as ArtifactMap;
}

/** A marker link is offered only when it is plain http(s); anything else is dropped. */
export function safeLink(link: string | undefined): string | null {
  if (link === undefined) return null;
  try {
    const u = new URL(link);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** `[west, south, east, north]` (MapLibre order) around the markers and routes; null with none. */
export function viewBounds(map: ArtifactMap): [number, number, number, number] | null {
  if (map.bounds) {
    const [s, w, n, e] = map.bounds;
    return [w, s, e, n];
  }
  const pts: [number, number][] = [
    ...map.markers.map((m): [number, number] => [m.lat, m.lng]),
    ...(map.routes ?? []).flatMap((r) => r.points as [number, number][]),
  ];
  if (pts.length === 0) return null;
  let w = 180;
  let s = 90;
  let e = -180;
  let n = -90;
  for (const [lat, lng] of pts) {
    w = Math.min(w, lng);
    e = Math.max(e, lng);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  }
  return [w, s, e, n];
}

/** GeoJSON for the clustered marker source (`id` is kept in properties for selection). */
export function markersGeoJson(markers: readonly ArtifactMapMarker[]) {
  return {
    type: "FeatureCollection" as const,
    features: markers.map((m) => ({
      type: "Feature" as const,
      properties: { id: m.id, label: m.label },
      geometry: { type: "Point" as const, coordinates: [m.lng, m.lat] as [number, number] },
    })),
  };
}

export function routesGeoJson(routes: NonNullable<ArtifactMap["routes"]>) {
  return {
    type: "FeatureCollection" as const,
    features: routes.map((r) => ({
      type: "Feature" as const,
      properties: { label: r.label ?? "" },
      geometry: {
        type: "LineString" as const,
        coordinates: r.points.map(([lat, lng]) => [lng, lat] as [number, number]),
      },
    })),
  };
}
