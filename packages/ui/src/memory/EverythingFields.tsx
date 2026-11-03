import {
  EVERYTHING_MEMORY_DEFAULTS,
  EVERYTHING_READABLE_SOURCES,
  type EverythingMemorySettings,
  type EverythingSource,
  effectiveEverythingSources,
  everythingOptOut,
} from "@psyche/protocol";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { t } from "../i18n/core.ts";
import { LearnMore } from "../screens/settings/LearnMore.tsx";
import { Group, RadioField, SwitchField } from "../screens/settings/shared.tsx";
import { estimateBackfill, estimateMonthly, formatUsd } from "./estimate.ts";

/** The pieces shared by Settings → Everything memory and the first-run consent. */

export type EverythingValues = EverythingMemorySettings;
export const EVERYTHING_KEY = "memory.everything";
export const EVERYTHING_LOCAL_CONFIRMED = "memory.everything.localConfirmed";

/** The sources the nightly pass reads. Browser pages and chats with Psyche are in the schema but never read, so no switch is shown. */
export const SOURCE_IDS: readonly EverythingSource[] = [
  "mail",
  "messages",
  "notes",
  "calendar",
  "reminders",
  "files",
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

/**
 * The stored `memory.everything` over the accepted defaults, so a partial value drops nothing.
 * Memory follows Search: `optOut` is the owner's per-source "Don't learn from this" (an older
 * value's switches are migrated), and `sources` is what memory learns from, indexed && !optOut,
 * so the cost, the per-source models and the consent summary all see the same list the Gateway
 * reads. `indexed` is the sources Search reads; unknown while it loads, when none is held back.
 */
export function readEverything(
  values: Readonly<Record<string, unknown>>,
  indexed?: ReadonlySet<EverythingSource>,
): EverythingValues {
  const stored = values[EVERYTHING_KEY];
  const merged = merge(structuredClone(EVERYTHING_MEMORY_DEFAULTS), stored) as EverythingValues;
  const optOut = everythingOptOut(stored);
  return {
    ...merged,
    optOut,
    sources: effectiveEverythingSources(optOut, indexed ?? EVERYTHING_READABLE_SOURCES),
  };
}

/** The local models whose memory warning the owner confirmed (one name, or a list). */
export function readConfirmed(raw: unknown): string[] {
  if (typeof raw === "string") return raw === "" ? [] : [raw];
  return Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string" && x !== "")
    : [];
}

/** The local model names the current choices would load (default and per-source overrides). */
export function localRefsInUse(value: EverythingValues): (string | null)[] {
  const refs: (string | null)[] = [];
  for (const s of SOURCE_IDS) {
    if (!value.sources[s]) continue;
    const per = (
      value.model.perSource as Record<string, { kind: string; ref?: string }> | undefined
    )?.[s];
    const choice = per ?? value.model.default;
    if (choice.kind === "local") refs.push(choice.ref ?? null);
  }
  // With no source on yet, the default alone decides.
  if (refs.length === 0 && value.model.default.kind === "local")
    refs.push(value.model.default.ref ?? null);
  return refs;
}

/** True when every local model in use is named and confirmed. */
export function localReady(value: EverythingValues, confirmed: readonly string[]): boolean {
  return localRefsInUse(value).every((r) => r !== null && confirmed.includes(r));
}

export function ModelFields({
  value,
  onChange,
  localConfirmed,
  onConfirmLocal,
  compact = false,
}: {
  /** In Settings the long warnings sit behind "Learn more"; the first-run consent shows them. */
  compact?: boolean;
  value: EverythingValues;
  onChange: (next: EverythingValues) => void;
  /** The local models the owner already confirmed. */
  localConfirmed: readonly string[];
  onConfirmLocal: (ref: string) => void;
}): ReactElement {
  const kind = value.model.default.kind;
  const ref = value.model.default.ref ?? "";
  const set = (next: { kind: "none" | "cloud" | "local"; ref?: string }) =>
    onChange({ ...value, model: { ...value.model, default: next } });
  const confirmed = kind === "local" && ref !== "" && localConfirmed.includes(ref);
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
        compact ? (
          <LearnMore className="px-3">
            <p>{t("everything.model.cloudNote")}</p>
          </LearnMore>
        ) : (
          <p className="px-3 text-callout text-label-secondary">
            {t("everything.model.cloudNote")}
          </p>
        )
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
            {compact ? (
              <LearnMore>
                <p>{t("everything.local.body")}</p>
              </LearnMore>
            ) : (
              <p>{t("everything.local.body")}</p>
            )}
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
  indexed,
  onEnable,
}: {
  value: EverythingValues;
  onChange: (next: EverythingValues) => void;
  /**
   * The sources Search reads now (unknown while it loads). Memory follows Search: a source it
   * reads is learned from unless opted out here; one it does not read is shown off, with a way to
   * let Psyche read it.
   */
  indexed?: ReadonlySet<EverythingSource>;
  /** Turns the Search source on: the same call as Settings → Essentials and Search sources. */
  onEnable?: (source: EverythingSource) => void | Promise<void>;
}): ReactElement {
  const [pending, setPending] = useState<ReadonlySet<EverythingSource>>(new Set());
  const enable = (s: EverythingSource) => {
    if (!onEnable) return;
    setPending((p) => new Set(p).add(s));
    void Promise.resolve(onEnable(s))
      .catch(() => undefined)
      .finally(() =>
        setPending((p) => {
          const next = new Set(p);
          next.delete(s);
          return next;
        }),
      );
  };
  return (
    <Group title={t("everything.sources.title")} description={t("everything.sources.description")}>
      {SOURCE_IDS.map((s) => {
        const name = t(`everything.source.${s}`);
        if (indexed !== undefined && !indexed.has(s)) {
          return (
            <SwitchField
              key={s}
              label={name}
              description={t("everything.sources.notRead", { source: name })}
              checked={false}
              disabled
              settingKey={EVERYTHING_KEY}
              onChange={() => undefined}
            >
              {onEnable ? (
                <div>
                  <Button
                    type="button"
                    variant="plain"
                    size="sm"
                    disabled={pending.has(s)}
                    onClick={() => enable(s)}
                  >
                    {t("everything.sources.letRead", { source: name })}
                  </Button>
                </div>
              ) : null}
            </SwitchField>
          );
        }
        const learning = value.optOut[s] !== true;
        return (
          <SwitchField
            key={s}
            label={name}
            description={t(
              learning ? "everything.sources.learning" : "everything.sources.notLearning",
            )}
            checked={learning}
            settingKey={EVERYTHING_KEY}
            onChange={(on) =>
              onChange({
                ...value,
                optOut: { ...value.optOut, [s]: !on },
                sources: { ...value.sources, [s]: on },
              })
            }
          />
        );
      })}
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
        onChange={(d) => onChange({ ...value, people: { ...value.people, default: d } })}
        options={(["two_way", "contacts", "everyone", "chosen"] as const).map((d) => ({
          value: d,
          label: t(`everything.people.${d}`),
        }))}
      />
      <SwitchField
        label={t("everything.people.aboutOthers")}
        description={t("everything.people.aboutOthersHint")}
        checked={value.people.aboutOthers}
        settingKey={EVERYTHING_KEY}
        onChange={(on) => onChange({ ...value, people: { ...value.people, aboutOthers: on } })}
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
  collapsed = false,
}: {
  value: EverythingValues;
  onChange: (next: EverythingValues) => void;
  /** Settings: the eight switches sit behind one line saying how many are allowed. */
  collapsed?: boolean;
}): ReactElement {
  const rows = SENSITIVE_IDS.map((c) => (
    <SwitchField
      key={c}
      label={t(`everything.sensitive.${c}`)}
      checked={value.sensitive[c]}
      settingKey={EVERYTHING_KEY}
      onChange={(on) => onChange({ ...value, sensitive: { ...value.sensitive, [c]: on } })}
    />
  ));
  return (
    <Group
      title={t("everything.sensitive.title")}
      description={t("everything.sensitive.description")}
    >
      {collapsed ? (
        <details className="group/topics">
          <summary className="flex cursor-default list-none items-center justify-between gap-3 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span>
              {t("memoryPrivacy.sensitiveSummary", {
                n: SENSITIVE_IDS.filter((c) => value.sensitive[c]).length,
                total: SENSITIVE_IDS.length,
              })}
            </span>
            <span className="inline-flex items-center gap-1 text-callout text-label-secondary">
              {t("memoryPrivacy.sensitiveChoose")}
              <ChevronRight
                aria-hidden="true"
                className="size-3 transition-transform duration-short ease-standard group-open/topics:rotate-90"
              />
            </span>
          </summary>
          <div className="mt-2 flex flex-col gap-2">{rows}</div>
        </details>
      ) : (
        rows
      )}
    </Group>
  );
}

type SourceChoice = "default" | "none" | "cloud" | "local";

/**
 * A different model for one source (§8, EM11): Messages on Local while Mail stays on Cloud, say.
 * Only sources that are switched on are listed. A local model here has its own memory warning
 * and its own confirmation, like the default one.
 */
export function PerSourceModels({
  value,
  onChange,
  localConfirmed,
  onConfirmLocal,
}: {
  value: EverythingValues;
  onChange: (next: EverythingValues) => void;
  localConfirmed: readonly string[];
  onConfirmLocal: (ref: string) => void;
}): ReactElement | null {
  const on = SOURCE_IDS.filter((s) => value.sources[s]);
  if (on.length === 0) return null;
  const per = (value.model.perSource ?? {}) as Record<
    string,
    { kind: "none" | "cloud" | "local"; ref?: string }
  >;
  const write = (
    source: EverythingSource,
    next: { kind: "none" | "cloud" | "local"; ref?: string } | undefined,
  ) => {
    const copy = { ...per };
    if (next === undefined) delete copy[source];
    else copy[source] = next;
    const { perSource: _drop, ...rest } = value.model;
    onChange({
      ...value,
      model: { ...rest, ...(Object.keys(copy).length === 0 ? {} : { perSource: copy }) },
    });
  };
  return (
    <Group
      title={t("everything.perSource.title")}
      description={t("everything.perSource.description")}
    >
      {on.map((s) => {
        const cur = per[s];
        const choice: SourceChoice = cur === undefined ? "default" : cur.kind;
        const ref = cur?.ref ?? "";
        const labelId = `persource-${s}`;
        return (
          <div key={s} data-testid="persource-row" className="flex flex-col gap-1 px-3">
            <div className="flex items-center justify-between gap-3">
              <label id={labelId} htmlFor={`${labelId}-select`} className="text-body">
                {t(`everything.source.${s}`)}
              </label>
              <NativeSelect
                id={`${labelId}-select`}
                value={choice}
                onChange={(e) => {
                  const v = e.target.value as SourceChoice;
                  write(
                    s,
                    v === "default"
                      ? undefined
                      : { kind: v, ...(v === "none" || ref === "" ? {} : { ref }) },
                  );
                }}
                className="h-7 w-44"
              >
                <option value="default">{t("everything.perSource.default")}</option>
                <option value="none">{t("everything.model.none")}</option>
                <option value="cloud">{t("everything.model.cloud")}</option>
                <option value="local">{t("everything.model.local")}</option>
              </NativeSelect>
            </div>
            {choice === "cloud" || choice === "local" ? (
              <Input
                aria-label={t("everything.perSource.ref", { source: t(`everything.source.${s}`) })}
                placeholder={
                  choice === "local"
                    ? t("everything.model.localRefHint")
                    : t("everything.model.cloudRefHint")
                }
                value={ref}
                maxLength={200}
                onChange={(e) =>
                  write(s, {
                    kind: choice,
                    ...(e.target.value.trim() === "" ? {} : { ref: e.target.value.trim() }),
                  })
                }
                className="h-7"
              />
            ) : null}
            {choice === "local" ? (
              ref === "" ? (
                <p className="text-callout text-label-secondary">
                  {t("everything.local.needsRef")}
                </p>
              ) : localConfirmed.includes(ref) ? (
                <p role="status" className="text-callout text-label-secondary">
                  {t("everything.local.confirmed", { model: ref })}
                </p>
              ) : (
                <div className="flex flex-col gap-1 text-callout" data-testid="persource-warning">
                  <p>{t("everything.local.body")}</p>
                  <Button size="sm" className="self-start" onClick={() => onConfirmLocal(ref)}>
                    {t("everything.local.confirm", { model: ref })}
                  </Button>
                </div>
              )
            ) : null}
          </div>
        );
      })}
    </Group>
  );
}
