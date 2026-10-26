import type { Artifact } from "@psyche/protocol";
import { Map as MapIcon } from "lucide-react";
import type { ReactElement } from "react";
import { Card } from "../blocks/card.tsx";
import { useArtifactContent } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { formatDate } from "../lib/format.ts";
import { useSlots } from "../slots.tsx";
import { MapPanel } from "./MapPanel.tsx";
import { parseMapContent } from "./map-model.ts";

/** The map artifact in the transcript: a compact card with "Open in canvas" for the full map. */
export function MapBlock({ artifact }: { artifact: Artifact }): ReactElement {
  const { content, error } = useArtifactContent(artifact.id, null);
  const { openArtifact } = useSlots();
  const map = content === null ? null : parseMapContent(content.content);
  return (
    <Card
      label={t("map.card", { title: artifact.title })}
      icon={<MapIcon />}
      title={artifact.title}
      meta={t("map.meta", {
        count: map?.markers.length ?? 0,
        date: formatDate(artifact.updatedAt),
      })}
      actions={
        openArtifact
          ? [
              {
                id: "open",
                label: t("map.openCanvas"),
                kind: "open",
                primary: true,
                onSelect: () => openArtifact(artifact),
              },
            ]
          : []
      }
      className="max-w-xl"
      data-testid="map-block"
    >
      <div className="mt-2">
        {map !== null ? (
          <MapPanel map={map} variant="inline" />
        ) : (
          <p className="text-callout text-label-secondary" role="status">
            {content === null && error === null ? t("canvas.loading") : t("map.invalid")}
          </p>
        )}
      </div>
    </Card>
  );
}
