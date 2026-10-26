import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import {
  DEFAULT_STYLE_LIGHT,
  MAP_STYLE_DARK_KEY,
  MAP_STYLE_KEY,
  MAP_TILES_KEY,
  validStyleUrl,
} from "../../map/map-model.ts";
import { bool, Group, SwitchField, TextSetting } from "./shared.tsx";

/**
 * Maps (chat map widget). Drawing a map asks a tile server for the area being viewed, which tells
 * that server roughly where you are looking. Off means the list only, with no request at all; the
 * tile server can be your own so nothing reaches a public one.
 */
export function MapGroup({
  values,
  onChange,
}: {
  values: Readonly<Record<string, unknown>>;
  onChange: (key: string, value: unknown) => void;
}): ReactElement {
  const on = bool(values, MAP_TILES_KEY, true);
  const text = (key: string): string => (typeof values[key] === "string" ? values[key] : "");
  // A typo'd or unsafe URL is not saved; the field keeps the last good value.
  const commit = (key: string) => (v: string) => {
    if (v === "" || validStyleUrl(v) !== null) onChange(key, v);
  };
  return (
    <Group title={t("settings.map.title")} description={t("settings.map.privacy")}>
      <SwitchField
        label={t("settings.map.tiles")}
        description={t("settings.map.tilesHint")}
        checked={on}
        settingKey={MAP_TILES_KEY}
        onChange={(v) => onChange(MAP_TILES_KEY, v)}
      />
      {on ? (
        <>
          <TextSetting
            label={t("settings.map.style")}
            description={t("settings.map.styleHint")}
            value={text(MAP_STYLE_KEY)}
            settingKey={MAP_STYLE_KEY}
            placeholder={DEFAULT_STYLE_LIGHT}
            maxLength={500}
            onCommit={commit(MAP_STYLE_KEY)}
          />
          <TextSetting
            label={t("settings.map.styleDark")}
            description={t("settings.map.styleDarkHint")}
            value={text(MAP_STYLE_DARK_KEY)}
            settingKey={MAP_STYLE_DARK_KEY}
            maxLength={500}
            onCommit={commit(MAP_STYLE_DARK_KEY)}
          />
        </>
      ) : null}
    </Group>
  );
}
