import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";

/**
 * What goes to the model provider (docs/design/psyche-points-2026.md §5.2): one line under Start
 * and under the toggle in Settings. With a local primary model the data stays on this computer.
 */
export function PointsDataLine({
  provider,
  local = false,
  className,
}: {
  /** The primary model's provider; absent says "your model provider". */
  provider?: string;
  local?: boolean;
  className?: string;
}): ReactElement {
  return (
    <p className={className ?? "text-callout text-label-secondary"} data-testid="points-data-line">
      {local
        ? t("points.sheet.data.local")
        : t("points.sheet.data.provider", {
            provider: provider ?? t("points.sheet.data.providerFallback"),
          })}
    </p>
  );
}
