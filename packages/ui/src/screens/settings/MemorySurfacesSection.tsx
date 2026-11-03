import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { usePersona } from "../../slots.tsx";
import {
  HIDEABLE_SOURCES,
  rawOf,
  readSurfaces,
  SURFACE_KINDS,
  SURFACE_SWITCHES,
  SURFACE_TIERS,
  SURFACES_KEY,
  type SurfaceKindId,
  type SurfaceSwitch,
  type SurfaceTierId,
  type SurfaceValues,
  withPath,
} from "./memory-work-values.ts";
import {
  Group,
  LoadGate,
  SectionFrame,
  SettingHint,
  SwitchField,
  useSettingsForm,
} from "./shared.tsx";

/**
 * Settings → Memory → Where memory shows (docs/design/memory-everything-2026.md §4): the tier and
 * surface switches, birthdays, kinds and sources, all stored in `memory.surfaces`. The Gateway
 * filters every surface through those values, so a change applies the next time Home, the brief
 * or a notification is built. The Memory page itself is not a surface and is never filtered.
 */

export function MemorySurfacesPanel({
  value,
  onSet,
}: {
  value: SurfaceValues;
  /** Writes one field of `memory.surfaces`, by dotted path. */
  onSet: (path: string, next: unknown) => void;
}): ReactElement {
  const peopleOn = SURFACE_SWITCHES.some((s) => value.tiers.people[s]);
  const tierDescription = (tier: SurfaceTierId) => t(`memorySurfaces.tier.${tier}.description`);
  const hidden = new Set(value.hideSources);
  const setHidden = (source: string, on: boolean) => {
    const next = on
      ? [...new Set([...value.hideSources, source])]
      : [...hidden].filter((s) => s !== source);
    onSet("hideSources", next);
  };
  return (
    <>
      {SURFACE_TIERS.map((tier) => (
        <Group
          key={tier}
          title={t(`memorySurfaces.tier.${tier}.title`)}
          description={tierDescription(tier)}
        >
          {SURFACE_SWITCHES.map((sw: SurfaceSwitch) => (
            <SwitchField
              key={sw}
              label={t(`memorySurfaces.surface.${sw}`)}
              {...(tier === "work" && sw === "notification"
                ? { description: t("memorySurfaces.tier.work.notificationHint") }
                : {})}
              settingKey={`memory.surfaces.tiers.${tier}.${sw}`}
              checked={value.tiers[tier][sw]}
              onChange={(on) => onSet(`tiers.${tier}.${sw}`, on)}
            />
          ))}
          {tier === "people" && peopleOn ? (
            <p role="status" className="text-callout text-label-secondary">
              {t("memorySurfaces.people.warning")}
            </p>
          ) : null}
        </Group>
      ))}

      <Group
        title={t("memorySurfaces.birthdays.title")}
        description={t("memorySurfaces.sensitive")}
      >
        <SwitchField
          label={t("memorySurfaces.birthdays.label")}
          description={t("memorySurfaces.birthdays.hint")}
          settingKey="memory.surfaces.birthdays"
          checked={value.birthdays}
          onChange={(on) => onSet("birthdays", on)}
        />
      </Group>

      <Group
        title={t("memorySurfaces.kinds.title")}
        description={t("memorySurfaces.kinds.description")}
      >
        {SURFACE_KINDS.map((kind: SurfaceKindId) => (
          <SwitchField
            key={kind}
            label={t(`memorySurfaces.kind.${kind}`)}
            settingKey={`memory.surfaces.kinds.${kind}`}
            checked={value.kinds[kind]}
            onChange={(on) => onSet(`kinds.${kind}`, on)}
          />
        ))}
      </Group>

      <Group
        title={t("memorySurfaces.sources.title")}
        description={t("memorySurfaces.sources.description")}
      >
        {HIDEABLE_SOURCES.map((source, i) => (
          <SwitchField
            key={source}
            label={t("memorySurfaces.sources.label", {
              source: t(`memorySurfaces.source.${source}`),
            })}
            // Search jumps to the first row; the key covers the whole list.
            {...(i === 0 ? { settingKey: "memory.surfaces.hideSources" } : {})}
            checked={hidden.has(source)}
            onChange={(on) => setHidden(source, on)}
          />
        ))}
      </Group>
    </>
  );
}

/** Connected: `memory.surfaces`. */
export function MemorySurfacesSection(): ReactElement {
  const form = useSettingsForm();
  const persona = usePersona();
  const onSet = (path: string, next: unknown) =>
    form.onChange(SURFACES_KEY, withPath(rawOf(form.values, SURFACES_KEY), path, next));
  return (
    <SectionFrame
      needsApproval={form.needsApproval}
      title={t("memorySurfaces.title")}
      description={t("memorySurfaces.description", { persona: persona.name })}
    >
      <LoadGate
        label={t("memorySurfaces.loadLabel")}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
      >
        <SettingHint settingKey={SURFACES_KEY} />
        <MemorySurfacesPanel value={readSurfaces(form.values)} onSet={onSet} />
      </LoadGate>
    </SectionFrame>
  );
}
