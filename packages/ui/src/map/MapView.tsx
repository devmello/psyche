import type { ArtifactMap } from "@psyche/protocol";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import {
  type MapSource,
  markersGeoJson,
  proxiedUrl,
  routesGeoJson,
  viewBounds,
} from "./map-model.ts";

/**
 * The tiled map (MapLibre GL JS, loaded on first use so the main bundle stays lean). It draws the
 * artifact's data and nothing else: the agent never sends code. `onFail` fires when the library,
 * WebGL or the style cannot load; the caller then shows the list alone.
 */

export interface MapViewProps {
  map: ArtifactMap;
  source: MapSource;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onFail: () => void;
  /** Inline cards need ⌘/Ctrl + scroll (or two fingers) to zoom, so the page keeps scrolling. */
  cooperative?: boolean;
  className?: string;
}

const SRC_MARKERS = "psyche-markers";
const SRC_ROUTES = "psyche-routes";
const ACCENT = "#3b6cf6";
const STYLE_TIMEOUT_MS = 12_000;

type MapLibre = typeof import("maplibre-gl");
type MLMap = import("maplibre-gl").Map;

export function MapView({
  map,
  source,
  selectedId,
  onSelect,
  onFail,
  cooperative = false,
  className,
}: MapViewProps): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<{ gl: MapLibre; map: MLMap } | null>(null);
  const latest = useRef({ map, selectedId, onSelect, onFail });
  latest.current = { map, selectedId, onSelect, onFail };
  const { resolved } = useTheme();
  const styleUrl = resolved === "dark" ? source.dark : source.light;
  const styleRef = useRef(styleUrl);
  const [ready, setReady] = useState(false);

  // Create the map once; the style follows the theme below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: created once, later props flow through refs
  useEffect(() => {
    let dead = false;
    let instance: MLMap | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        const [gl] = await Promise.all([
          import("maplibre-gl"),
          import("maplibre-gl/dist/maplibre-gl.css"),
        ]);
        if (dead || host.current === null) return;
        const m = new gl.Map({
          container: host.current,
          style: styleRef.current,
          attributionControl: { compact: true },
          cooperativeGestures: cooperative,
          locale: {
            "CooperativeGesturesHandler.WindowsHelpText": t("map.gesture.windows"),
            "CooperativeGesturesHandler.MacHelpText": t("map.gesture.mac"),
            "CooperativeGesturesHandler.MobileHelpText": t("map.gesture.mobile"),
          },
          transformRequest: (url) => ({ url: proxiedUrl(url, window.location.origin) }),
          dragRotate: false,
          pitchWithRotate: false,
          fadeDuration: 0,
        });
        instance = m;
        live.current = { gl, map: m };
        m.touchZoomRotate.disableRotation();
        timer = setTimeout(() => {
          if (!m.isStyleLoaded()) latest.current.onFail();
        }, STYLE_TIMEOUT_MS);
        m.on("error", (e) => {
          // A tile that fails leaves the markers drawn; only a style that never loads is fatal.
          if (!m.isStyleLoaded() && !(e as { sourceId?: string }).sourceId) latest.current.onFail();
        });
        m.on("style.load", () => {
          clearTimeout(timer);
          draw(gl, m, latest.current);
          setReady(true);
        });
      } catch {
        if (!dead) latest.current.onFail();
      }
    })();
    return () => {
      dead = true;
      clearTimeout(timer);
      instance?.remove();
      live.current = null;
    };
  }, []);

  // The map follows the theme: swap the style, and `style.load` redraws the data.
  useEffect(() => {
    if (styleRef.current === styleUrl) return;
    styleRef.current = styleUrl;
    live.current?.map.setStyle(styleUrl);
  }, [styleUrl]);

  // New data (an `addMarker` op, a new version): update the sources in place.
  useEffect(() => {
    const m = live.current?.map;
    if (!ready || !m?.isStyleLoaded()) return;
    (m.getSource(SRC_MARKERS) as import("maplibre-gl").GeoJSONSource | undefined)?.setData(
      markersGeoJson(map.markers),
    );
    (m.getSource(SRC_ROUTES) as import("maplibre-gl").GeoJSONSource | undefined)?.setData(
      routesGeoJson(map.routes ?? []),
    );
  }, [map, ready]);

  // Selection: highlight and fly there.
  useEffect(() => {
    const cur = live.current;
    if (!ready || !cur?.map.isStyleLoaded()) return;
    cur.map.setFilter("psyche-selected", ["==", ["get", "id"], selectedId ?? ""]);
    const marker = map.markers.find((p) => p.id === selectedId);
    if (marker)
      cur.map.flyTo({
        center: [marker.lng, marker.lat],
        zoom: Math.max(cur.map.getZoom(), 14),
        essential: false,
      });
  }, [selectedId, ready, map.markers]);

  return (
    <div
      ref={host}
      role="application"
      aria-label={t("map.label", { title: map.title ?? t("map.untitled") })}
      data-testid="map-view"
      className={cn("size-full overflow-hidden rounded-md bg-fill-tertiary", className)}
    />
  );
}

function draw(
  gl: MapLibre,
  m: MLMap,
  cur: { map: ArtifactMap; selectedId: string | null; onSelect: (id: string | null) => void },
): void {
  const { map } = cur;
  m.addSource(SRC_ROUTES, { type: "geojson", data: routesGeoJson(map.routes ?? []) });
  m.addLayer({
    id: "psyche-routes",
    type: "line",
    source: SRC_ROUTES,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ACCENT, "line-width": 4, "line-opacity": 0.8 },
  });
  m.addSource(SRC_MARKERS, {
    type: "geojson",
    data: markersGeoJson(map.markers),
    cluster: true,
    clusterRadius: 44,
    clusterMaxZoom: 13,
  });
  m.addLayer({
    id: "psyche-clusters",
    type: "circle",
    source: SRC_MARKERS,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": ACCENT,
      "circle-radius": ["step", ["get", "point_count"], 16, 10, 20, 50, 26],
      "circle-stroke-width": 3,
      "circle-stroke-color": "#ffffff",
    },
  });
  m.addLayer({
    id: "psyche-cluster-count",
    type: "symbol",
    source: SRC_MARKERS,
    filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12 },
    paint: { "text-color": "#ffffff" },
  });
  m.addLayer({
    id: "psyche-points",
    type: "circle",
    source: SRC_MARKERS,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": ACCENT,
      "circle-radius": 8,
      "circle-stroke-width": 3,
      "circle-stroke-color": "#ffffff",
    },
  });
  m.addLayer({
    id: "psyche-selected",
    type: "circle",
    source: SRC_MARKERS,
    filter: ["==", ["get", "id"], cur.selectedId ?? ""],
    paint: {
      "circle-color": "#f5a524",
      "circle-radius": 11,
      "circle-stroke-width": 3,
      "circle-stroke-color": "#ffffff",
    },
  });
  m.on("click", "psyche-points", (e) => {
    const id = e.features?.[0]?.properties?.id;
    if (typeof id === "string") cur.onSelect(id);
  });
  m.on("click", "psyche-selected", (e) => {
    const id = e.features?.[0]?.properties?.id;
    if (typeof id === "string") cur.onSelect(id);
  });
  m.on("click", "psyche-clusters", async (e) => {
    const f = e.features?.[0];
    const src = m.getSource(SRC_MARKERS) as import("maplibre-gl").GeoJSONSource;
    if (f?.geometry.type !== "Point") return;
    const zoom = await src.getClusterExpansionZoom(f.properties?.cluster_id as number);
    m.easeTo({ center: f.geometry.coordinates as [number, number], zoom });
  });
  for (const layer of ["psyche-points", "psyche-clusters", "psyche-selected"]) {
    m.on("mouseenter", layer, () => {
      m.getCanvas().style.cursor = "pointer";
    });
    m.on("mouseleave", layer, () => {
      m.getCanvas().style.cursor = "";
    });
  }
  const b = viewBounds(map);
  if (b) {
    const [w, s, e, n] = b;
    m.fitBounds(new gl.LngLatBounds([w, s], [e, n]), {
      padding: 36,
      maxZoom: 15,
      animate: false,
      duration: 0,
    });
  }
}
