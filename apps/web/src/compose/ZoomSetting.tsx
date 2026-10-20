import { t, useSettingsForm } from "@psyche/ui";
import type { ReactElement } from "react";
import { clampZoom, ZOOM_DEFAULT, ZOOM_KEY, ZOOM_MAX, ZOOM_MIN, zoomStep } from "./zoom.ts";

const button =
  "inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-sm font-medium shadow-xs hover:bg-gray-3 disabled:opacity-50";

/** Settings → Appearance → Zoom (desktop): the stored percentage with step and reset buttons. */
export function ZoomSetting(): ReactElement {
  const form = useSettingsForm();
  const zoom = clampZoom(form.values[ZOOM_KEY]);
  const set = (next: number) => form.onChange(ZOOM_KEY, clampZoom(next));
  return (
    <section
      aria-labelledby="zoom-title"
      className="flex flex-col gap-3 rounded-lg border border-gray-6 bg-gray-2 p-4 text-sm"
      data-testid="settings-zoom"
    >
      <div>
        <h3 id="zoom-title" className="text-base font-semibold text-foreground">
          {t("web.zoom.title")}
        </h3>
        <p className="text-muted-foreground">
          {t("web.zoom.description", { min: ZOOM_MIN, max: ZOOM_MAX })}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <output className="w-16 font-medium text-foreground" aria-live="polite">
          {t("web.zoom.value", { zoom })}
        </output>
        <button
          type="button"
          className={button}
          disabled={zoom <= ZOOM_MIN}
          onClick={() => set(zoomStep(zoom, -1))}
          aria-label={t("web.zoom.out")}
        >
          −
        </button>
        <button
          type="button"
          className={button}
          disabled={zoom >= ZOOM_MAX}
          onClick={() => set(zoomStep(zoom, 1))}
          aria-label={t("web.zoom.in")}
        >
          +
        </button>
        <button
          type="button"
          className={button}
          disabled={zoom === ZOOM_DEFAULT}
          onClick={() => set(ZOOM_DEFAULT)}
        >
          {t("web.zoom.actualSize")}
        </button>
      </div>
      {form.writeError ? (
        <p role="alert" className="text-danger-text">
          {form.writeError}
        </p>
      ) : null}
    </section>
  );
}
