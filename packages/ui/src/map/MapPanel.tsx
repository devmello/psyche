import type { ArtifactMap } from "@psyche/protocol";
import { List, Map as MapIcon } from "lucide-react";
import { lazy, type ReactElement, Suspense, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useSettings } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { MapList } from "./MapList.tsx";
import { type MapSource, mapSourceOf } from "./map-model.ts";

// The map code (MapLibre) is a separate chunk, fetched only when a map is first shown.
const MapView = lazy(() => import("./MapView.tsx").then((m) => ({ default: m.MapView })));

export interface MapPanelProps {
  map: ArtifactMap;
  /** `inline`: a fixed-height card in the transcript. `full`: the canvas, map beside the list. */
  variant: "inline" | "full";
  /** Overrides the tile settings (stories and tests). */
  source?: MapSource;
  /** Pretend the tiles failed (stories). */
  forceFailed?: boolean;
}

/** The map widget: tiles when allowed and working, the list otherwise. */
export function MapPanel({
  map,
  variant,
  source,
  forceFailed = false,
}: MapPanelProps): ReactElement {
  const { settings } = useSettings();
  const src = source ?? mapSourceOf(settings);
  const [failed, setFailed] = useState(forceFailed);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const selected = map.markers.find((m) => m.id === selectedId) ?? null;

  if (map.markers.length === 0)
    return <p className="text-callout text-label-secondary">{t("map.empty")}</p>;

  const tiled = src.tiles && !failed;
  const reason = !src.tiles ? t("map.tilesOff") : failed ? t("map.tilesFailed") : null;
  const list = (
    <MapList
      map={map}
      selectedId={selectedId}
      onSelect={setSelectedId}
      className={variant === "full" ? "max-h-full overflow-auto" : "max-h-56 overflow-auto"}
    />
  );
  const view = (
    <Suspense fallback={<div className="size-full rounded-md bg-fill-tertiary" />}>
      <MapView
        map={map}
        source={src}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onFail={() => setFailed(true)}
        cooperative={variant === "inline"}
      />
    </Suspense>
  );

  if (variant === "full")
    return (
      <div className="flex h-full min-h-72 flex-col gap-3 md:flex-row" data-testid="map-panel">
        {tiled ? <div className="min-h-72 flex-1">{view}</div> : null}
        <div className={cn("flex min-h-0 flex-col gap-2", tiled ? "md:w-64" : "w-full")}>
          {reason ? (
            <p role="status" className="text-subheadline text-label-secondary">
              {reason}
            </p>
          ) : null}
          {list}
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-2" data-testid="map-panel">
      {reason ? (
        <p role="status" className="text-subheadline text-label-secondary">
          {reason}
        </p>
      ) : null}
      {tiled && !showList ? <div className="h-56">{view}</div> : list}
      {tiled && !showList && selected ? (
        <p className="text-callout text-label-primary">
          <span className="font-medium">{selected.label}</span>
          {selected.note ? <span className="text-label-secondary"> · {selected.note}</span> : null}
        </p>
      ) : null}
      {tiled ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          aria-pressed={showList}
          onClick={() => setShowList((v) => !v)}
        >
          {showList ? <MapIcon aria-hidden="true" /> : <List aria-hidden="true" />}
          {showList ? t("map.showMap") : t("map.showList")}
        </Button>
      ) : null}
    </div>
  );
}
