import type { ArtifactMap } from "@psyche/protocol";
import { ExternalLink, MapPin } from "lucide-react";
import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { safeLink } from "./map-model.ts";

/**
 * The places as a list: the accessible way to use the map, and the whole widget when tiles are
 * off, fail to load, or the places have no coordinates. Selecting a row selects its marker.
 */
export function MapList({
  map,
  selectedId,
  onSelect,
  className,
}: {
  map: ArtifactMap;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  className?: string;
}): ReactElement {
  return (
    <ul aria-label={t("map.list")} className={cn("flex flex-col gap-0.5", className)}>
      {map.markers.map((m) => {
        const selected = m.id === selectedId;
        const link = safeLink(m.link);
        return (
          <li key={m.id} className="min-w-0">
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(selected ? null : m.id)}
              className={cn(
                "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "bg-fill-secondary" : "hover:bg-fill-tertiary",
              )}
            >
              <MapPin
                className="mt-0.5 size-3.5 shrink-0 text-label-secondary"
                aria-hidden="true"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-callout font-medium text-label-primary">
                  {m.label}
                </span>
                {selected && m.note ? (
                  <span className="text-subheadline text-label-secondary">{m.note}</span>
                ) : null}
              </span>
            </button>
            {selected && link ? (
              <a
                href={link}
                target="_blank"
                rel="noreferrer noopener"
                className="ms-7 inline-flex items-center gap-1 text-subheadline text-accent-11 underline-offset-2 hover:underline"
              >
                {t("map.openLink")}
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
