import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { bool, Group, SwitchField } from "./shared.tsx";

/** The setting that lets generative-UI widgets show images from the web (D3); off by default. */
export const WIDGET_REMOTE_IMAGES_KEY = "widgets.remoteImages";

/**
 * Widgets (generative-ui-2026 §7.2). A widget Psyche draws in the chat may point at a picture on
 * the web. Off, those show a note and nothing is fetched. On, the Gateway fetches the picture for
 * you (no cookies, no referrer, never from your device), and in a widget built from untrusted
 * content it still waits for you to click Load image.
 */
export function WidgetGroup({
  values,
  onChange,
}: {
  values: Readonly<Record<string, unknown>>;
  onChange: (key: string, value: unknown) => void;
}): ReactElement {
  return (
    <Group title={t("settings.widgets.title")} description={t("settings.widgets.privacy")}>
      <SwitchField
        label={t("settings.widgets.remoteImages")}
        description={t("settings.widgets.remoteImagesHint")}
        checked={bool(values, WIDGET_REMOTE_IMAGES_KEY, false)}
        settingKey={WIDGET_REMOTE_IMAGES_KEY}
        onChange={(v) => onChange(WIDGET_REMOTE_IMAGES_KEY, v)}
      />
    </Group>
  );
}
