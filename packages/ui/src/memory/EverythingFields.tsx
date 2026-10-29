import {
  EVERYTHING_MEMORY_DEFAULTS,
  type EverythingMemorySettings,
  type EverythingSource,
} from "@psyche/protocol";
import { TriangleAlert } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { t } from "../i18n/core.ts";
import { Group, RadioField, SwitchField } from "../screens/settings/shared.tsx";
import { estimateBackfill, estimateMonthly, formatUsd } from "./estimate.ts";

/** The pieces shared by Settings → Everything memory and the first-run consent. */

export type EverythingValues = EverythingMemorySettings;
export const EVERYTHING_KEY = "memory.everything";
export const EVERYTHING_LOCAL_CONFIRMED = "memory.everything.localConfirmed";

export const SOURCE_IDS: readonly EverythingSource[] = [
  "mail",
  "messages",
  "notes",
  "calendar",
  "reminders",
  "chats",
  "files",
  "browser",
  "transcripts",
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
function merge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

/** The stored `memory.everything` over the accepted defaults, so a partial value drops nothing. */
export function readEverything(values: Readonly<Record<string, unknown>>): EverythingValues {
  return merge(
    structuredClone(EVERYTHING_MEMORY_DEFAULTS),
    values[EVERYTHING_KEY],
  ) as EverythingValues;
}

export function ModelFields({
  value,
  onChange,
  localConfirmed,
  onConfirmLocal,
}: {
  value: EverythingValues;
  onChange: (next: EverythingValues) => void;
  /** The local model the owner already confirmed, if any. */
  localConfirmed: string | undefined;
  onConfirmLocal: (ref: string) => void;
}): ReactElement {
  const kind = value.model.default.kind;
  const ref = value.model.default.ref ?? "";
  const set = (next: { kind: "none" | "cloud" | "local"; ref?: string }) =>
    onChange({ ...value, model: { ...value.model, default: next } });
  const confirmed = kind === "local" && ref !== "" && localConfirmed === ref;
  const estimate = estimateMonthly(kind, value.sources);
  const days = Number(value.schedule.backfillDays);
  return (
    <Group title={t("everything.model.title")}>
      <RadioField
        label={t("everything.model.title")}
        hideLabel
        grouped
        value={kind}
        onChange={(k) => set({ kind: k, ...(k === "none" || ref === "" ? {} : { ref }) })}
        options={[
          {
            value: "none",
            label: t("everything.model.none"),
            hint: t("everything.model.noneHint"),
          },
          {
            value: "cloud",
            label: t("everything.model.cloud"),
            hint: t("everything.model.cloudHint"),
          },
          {
            value: "local",
            label: t("everything.model.local"),
            hint: t("everything.model.localHint"),
          },
        ]}
      />
      {kind !== "none" ? (
        <div className="flex flex-col gap-1 px-3">
          <label className="text-body" htmlFor="everything-model-ref">
            {kind === "local" ? t("everything.model.localRef") : t("everything.model.cloudRef")}
          </label>
          <p className="text-callout text-label-secondary">
            {kind === "local"
              ? t("everything.model.localRefHint")
              : t("everything.model.cloudRefHint")}
          </p>
          <Input
            id="everything-model-ref"
            value={ref}
            maxLength={200}
            onChange={(e) =>
              set({ kind, ...(e.target.value === "" ? {} : { ref: e.target.value.trim() }) })
            }
            className="h-7 sm:w-72"
          />
        </div>
      ) : null}
      {kind === "cloud" ? (
        <p className="px-3 text-callout text-label-secondary">{t("everything.model.cloudNote")}</p>
      ) : null}
      {kind === "local" ? (
        <div
          role="note"
          data-testid="local-model-warning"
          className="mx-3 flex gap-2 rounded-lg bg-approval-bg px-3 py-2 text-callout"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-approval-text" />
          <div className="flex flex-col gap-2">
            <p className="font-medium">{t("everything.local.title")}</p>
            <p>{t("everything.local.body")}</p>
            {confirmed ? (
              <p role="status">{t("everything.local.confirmed", { model: ref })}</p>
            ) : ref === "" ? (
              <p>{t("everything.local.needsRef")}</p>
            ) : (
              <Button size="sm" className="self-start" onClick={() => onConfirmLocal(ref)}>
                {t("everything.local.confirm", { model: ref })}
              </Button>
            )}
          </div>
        </div>
      ) : null}
      <p data-testid="everything-cost" className="px-3 text-callout text-label-secondary">
        {kind === "cloud"
          ? t("everything.cost.cloud", {
              typical: formatUsd(estimate.typical),
              low: formatUsd(estimate.low),
              high: formatUsd(estimate.high),
            })
          : t("everything.cost.free")}
        {kind === "cloud" && days > 0
          ? ` ${t("everything.cost.backfill", {
              days,
              cost: formatUsd(estimateBackfill(kind, value.sources, days)),
            })}`
          : ""}
      </p>
    </Group>
  );
}

export function SourceFields({
  value,
  onChange,
}: {
  value: EverythingValues;
  onChange: (next: EverythingValues) => void;
}): ReactElement {
  return (
    <Group title={t("everything.sources.title")} description={t("everything.sources.description")}>
      {SOURCE_IDS.map((s) => (
        <SwitchField
          key={s}
          label={t(`everything.source.${s}`)}
          checked={value.sources[s]}
          settingKey={EVERYTHING_KEY}
          onChange={(on) => onChange({ ...value, sources: { ...value.sources, [s]: on } })}
        />
      ))}
    </Group>
  );
}

export function PeopleFields({
  value,
  onChange,
}: {
  value: EverythingValues;
  onChange: (next: EverythingValues) => void;
}): ReactElement {
  return (
    <Group title={t("everything.people.title")} description={t("everything.people.note")}>
      <RadioField
        label={t("everything.people.default")}
        grouped
        value={value.people.default}
        onChange={(d) => onChange({ ...value, people: { default: d } })}
        options={(["two_way", "contacts", "everyone", "chosen"] as const).map((d) => ({
          value: d,
          label: t(`everything.people.${d}`),
        }))}
      />
    </Group>
  );
}

export const SENSITIVE_IDS = [
  "health",
  "finance",
  "sexuality",
  "religion",
  "politics",
  "ethnicity",
  "legal",
  "precise_location",
] as const;

export function SensitiveFields({
  value,
  onChange,
}: {
  value: EverythingValues;
  onChange: (next: EverythingValues) => void;
}): ReactElement {
  return (
    <Group
      title={t("everything.sensitive.title")}
      description={t("everything.sensitive.description")}
    >
      {SENSITIVE_IDS.map((c) => (
        <SwitchField
          key={c}
          label={t(`everything.sensitive.${c}`)}
          checked={value.sensitive[c]}
          settingKey={EVERYTHING_KEY}
          onChange={(on) => onChange({ ...value, sensitive: { ...value.sensitive, [c]: on } })}
        />
      ))}
    </Group>
  );
}
