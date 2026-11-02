import type { GraphSource, GraphStatus } from "@psyche/protocol";
import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { Group, RadioField, SwitchField } from "./shared.tsx";

/**
 * The People and projects settings value (docs/memory/people-and-projects-2026.md §6.7, §7) and
 * the groups of it that sit under Memory → Advanced: how cards are kept up to date, and how long
 * interactions stay. The switch, sources and cards are on the People section.
 */

export const GRAPH_SETTING = "memory.graph";

export interface GraphSettings {
  enabled: boolean;
  sources: Record<GraphSource, boolean>;
  interactionRetentionDays: number;
  entityRecall: boolean;
  model: {
    nightly: boolean;
    afterRun: boolean;
    maxEntitiesPerNight: number;
    maxTokensPerNight: number;
  };
}

/** The sources the owner can turn on, each off until then. */
export const GRAPH_SOURCES: readonly GraphSource[] = [
  "contacts",
  "mail",
  "calendar",
  "messages",
  "notes",
  "chats",
];

/** The spec's defaults (§4.7): off, sources off except chats (the owner's own words). */
export const GRAPH_DEFAULTS: GraphSettings = {
  enabled: false,
  sources: {
    contacts: false,
    mail: false,
    calendar: false,
    messages: false,
    notes: false,
    chats: true,
  },
  interactionRetentionDays: 540,
  entityRecall: true,
  model: { nightly: true, afterRun: true, maxEntitiesPerNight: 200, maxTokensPerNight: 150000 },
};

/** The stored object merged over the defaults, so a partial value never drops a field. */
export function readGraphSettings(values: Readonly<Record<string, unknown>>): GraphSettings {
  const raw = values[GRAPH_SETTING];
  const v = (raw && typeof raw === "object" ? raw : {}) as Partial<GraphSettings>;
  return {
    ...GRAPH_DEFAULTS,
    ...v,
    sources: { ...GRAPH_DEFAULTS.sources, ...(v.sources ?? {}) },
    model: { ...GRAPH_DEFAULTS.model, ...(v.model ?? {}) },
  };
}

const RETENTION_DAYS = ["180", "365", "540", "730"] as const;

/** How cards are built and how long interactions stay (only meaningful while the graph is on). */
export function PeopleAdvancedGroups({
  settings,
  onChange,
  status = null,
  persona,
}: {
  settings: GraphSettings;
  onChange: (next: GraphSettings) => void;
  status?: GraphStatus | null;
  persona: string;
}): ReactElement {
  const set = (patch: Partial<GraphSettings>) => onChange({ ...settings, ...patch });
  return (
    <>
      <Group
        title={t("settings.people.learning")}
        description={
          status
            ? t("settings.people.budget", {
                tokens: status.budget.tokensUsed,
                maxTokens: status.budget.maxTokens,
                entities: status.budget.entitiesUsed,
                maxEntities: status.budget.maxEntities,
              })
            : t("settings.people.learningHint")
        }
      >
        <SwitchField
          label={t("settings.people.entityRecall")}
          description={t("settings.people.entityRecallHint", { persona })}
          checked={settings.entityRecall}
          onChange={(entityRecall) => set({ entityRecall })}
        />
        <SwitchField
          label={t("settings.people.nightly")}
          description={t("settings.people.nightlyHint")}
          checked={settings.model.nightly}
          onChange={(nightly) => set({ model: { ...settings.model, nightly } })}
        />
        <SwitchField
          label={t("settings.people.afterRun")}
          description={t("settings.people.afterRunHint")}
          checked={settings.model.afterRun}
          onChange={(afterRun) => set({ model: { ...settings.model, afterRun } })}
        />
        {status && status.loopPrecision.length > 0 ? (
          <p className="text-callout text-label-secondary">
            {t("settings.people.precision", {
              list: status.loopPrecision
                .map((p) =>
                  t("settings.people.precisionItem", {
                    source: t(`settings.people.source.${p.source}`),
                    confirmed: p.confirmed,
                    total: p.confirmed + p.dismissed,
                  }),
                )
                .join(", "),
            })}
          </p>
        ) : null}
      </Group>
      <Group title={t("settings.people.retention")}>
        <RadioField
          label={t("settings.people.retentionLabel")}
          description={t("settings.people.retentionHint")}
          inline
          value={
            RETENTION_DAYS.find((d) => Number(d) === settings.interactionRetentionDays) ?? "540"
          }
          onChange={(v) => set({ interactionRetentionDays: Number(v) })}
          options={RETENTION_DAYS.map((d) => ({
            value: d,
            label: t("settings.people.months", { n: Math.round(Number(d) / 30) }),
          }))}
        />
      </Group>
    </>
  );
}
