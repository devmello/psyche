import type { PermissionMode, SpecialistBudgetSetting, SpecialistRole } from "@psyche/protocol";
import { type ReactElement, useEffect, useId, useState } from "react";
import { Input } from "../../components/ui/input.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { useSpecialistRoles } from "../../data/specialists.ts";
import { t } from "../../i18n/core.ts";
import { formatTokenCount, formatUsd, roleGlyph } from "../../specialists/model.ts";
import {
  bool,
  ErrorNotice,
  Group,
  LoadGate,
  num,
  RadioField,
  SectionFrame,
  SettingHint,
  type SettingsFormProps,
  SwitchField,
  useSettingsForm,
} from "./shared.tsx";

/** Settings → Specialists (docs/agent/specialists-2026.md §6.4). Admin keys, except Feed. */
export const SPECIALIST_KEYS = {
  maxConcurrent: "specialists.maxConcurrent",
  monthlyCapUsd: "specialists.monthlyCapUsd",
  showInFeed: "specialists.showInFeed",
  enabled: (role: string) => `specialists.enabled.${role}`,
  model: (role: string) => `specialists.model.${role}`,
  budget: (role: string) => `specialists.budget.${role}`,
  maxMode: (role: string) => `specialists.maxMode.${role}`,
} as const;

const CONCURRENCY = [1, 2, 3, 4, 5, 6] as const;
const MODES = ["plan", "manual", "balanced", "auto"] as const;
type Mode = (typeof MODES)[number];

/** The role as Settings shows it: the skill's definition with the owner's values on top. */
export function effectiveRole(
  role: SpecialistRole,
  values: SettingsFormProps["values"],
): {
  enabled: boolean;
  model: string | null;
  budget: SpecialistBudgetSetting;
  maxMode: PermissionMode;
} {
  const model = values[SPECIALIST_KEYS.model(role.role)];
  const budget = values[SPECIALIST_KEYS.budget(role.role)];
  const mode = values[SPECIALIST_KEYS.maxMode(role.role)];
  return {
    enabled: bool(values, SPECIALIST_KEYS.enabled(role.role), role.enabled),
    model: typeof model === "string" && model !== "" ? model : (role.model ?? null),
    budget:
      typeof budget === "object" && budget !== null
        ? { ...role.budget, ...(budget as SpecialistBudgetSetting) }
        : role.budget,
    maxMode: (MODES as readonly string[]).includes(mode as string)
      ? (mode as PermissionMode)
      : role.maxMode,
  };
}

/** A number that commits on blur or Return, clamped to `max`; empty clears it. */
function NumberField({
  label,
  value,
  max,
  step = 1,
  onCommit,
}: {
  label: string;
  value: number | undefined;
  max?: number | undefined;
  step?: number;
  onCommit: (value: number | undefined) => void;
}): ReactElement {
  const id = useId();
  const shown = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) {
      setDraft(shown);
      return;
    }
    const next = max === undefined ? n : Math.min(n, max);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-callout text-label-secondary">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step={step}
        {...(max === undefined ? {} : { max })}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        className="tabular-nums"
      />
    </div>
  );
}

function RoleRow({
  role,
  values,
  onChange,
  models,
  defaultOpen,
}: {
  role: SpecialistRole;
  values: SettingsFormProps["values"];
  onChange: SettingsFormProps["onChange"];
  models: readonly string[];
  defaultOpen: boolean;
}): ReactElement {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const eff = effectiveRole(role, values);
  const Glyph = roleGlyph(role.role);
  const classLabel = t(`settings.specialists.class.${role.modelClass}`);
  const budget = eff.budget;
  const summary = t("settings.specialists.summary", {
    model: eff.model ?? classLabel,
    budget: t("settings.specialists.budgetLine", {
      tokens: formatTokenCount(budget.tokens ?? 0),
      cost: formatUsd(budget.costUsd ?? 0),
      minutes: budget.minutes ?? 0,
    }),
    mode: t(`settings.specialists.mode.${eff.maxMode}`),
  });
  const setBudget = (patch: Partial<SpecialistBudgetSetting>) => {
    const next: SpecialistBudgetSetting = { ...budget };
    for (const [k, v] of Object.entries(patch) as [keyof SpecialistBudgetSetting, unknown][]) {
      if (v === undefined) delete next[k];
      else next[k] = v as never;
    }
    onChange(SPECIALIST_KEYS.budget(role.role), next);
  };
  const modelOptions =
    eff.model !== null && !models.includes(eff.model) ? [eff.model, ...models] : models;
  return (
    <div className="flex flex-col gap-2" data-testid={`specialist-role-${role.role}`}>
      <div className="flex items-start gap-3">
        <Glyph className="mt-0.5 size-4 shrink-0 text-label-secondary" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span id={`${id}-label`} className="text-body text-label-primary">
            {role.label}
          </span>
          <span className="text-callout text-label-secondary">
            {role.description}
            {role.source === "bundled"
              ? null
              : ` ${t("settings.specialists.installed", { skill: role.skill })}`}
          </span>
          <span className="text-callout text-label-tertiary tabular-nums">{summary}</span>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={`${id}-edit`}
          aria-label={t("settings.specialists.editLabel", { role: role.label })}
          className="h-6 shrink-0 cursor-default rounded-sm px-1.5 text-callout text-accent-11 outline-none hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? t("settings.specialists.done") : t("settings.specialists.edit")}
        </button>
        <Switch
          aria-label={t("settings.specialists.turnOn", { role: role.label })}
          checked={eff.enabled}
          onCheckedChange={(v) => onChange(SPECIALIST_KEYS.enabled(role.role), v)}
        />
      </div>
      <SettingHint settingKey={SPECIALIST_KEYS.enabled(role.role)} />
      {open ? (
        <div id={`${id}-edit`} className="flex flex-col gap-3 ps-7 pb-1">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-model`} className="text-callout text-label-secondary">
              {t("settings.specialists.model")}
            </label>
            <NativeSelect
              id={`${id}-model`}
              className="min-w-56"
              value={eff.model ?? ""}
              onChange={(e) =>
                onChange(
                  SPECIALIST_KEYS.model(role.role),
                  e.target.value === "" ? null : e.target.value,
                )
              }
            >
              <option value="">
                {t("settings.specialists.modelDefault", { class: classLabel })}
              </option>
              {modelOptions.map((ref) => (
                <option key={ref} value={ref}>
                  {ref}
                </option>
              ))}
            </NativeSelect>
            <SettingHint settingKey={SPECIALIST_KEYS.model(role.role)} />
          </div>
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="mb-1 text-callout text-label-secondary">
              {t("settings.specialists.budget")}
            </legend>
            <div className="flex flex-wrap gap-2">
              <NumberField
                label={t("settings.specialists.budgetTokens")}
                value={budget.tokens}
                max={role.caps.tokens}
                step={10_000}
                onCommit={(tokens) => setBudget({ tokens })}
              />
              <NumberField
                label={t("settings.specialists.budgetCost")}
                value={budget.costUsd}
                max={role.caps.costUsd}
                step={0.5}
                onCommit={(costUsd) => setBudget({ costUsd })}
              />
              <NumberField
                label={t("settings.specialists.budgetMinutes")}
                value={budget.minutes}
                max={role.caps.minutes}
                step={5}
                onCommit={(minutes) => setBudget({ minutes })}
              />
            </div>
            <p className="text-callout text-label-tertiary">
              {t("settings.specialists.budgetCaps", {
                tokens: formatTokenCount(role.caps.tokens ?? 0),
                cost: formatUsd(role.caps.costUsd ?? 0),
                minutes: role.caps.minutes ?? 0,
              })}
            </p>
            <SettingHint settingKey={SPECIALIST_KEYS.budget(role.role)} />
          </fieldset>
          <RadioField<Mode>
            label={t("settings.specialists.maxMode")}
            value={eff.maxMode}
            options={MODES.map((m) => ({ value: m, label: t(`settings.specialists.mode.${m}`) }))}
            onChange={(m) => onChange(SPECIALIST_KEYS.maxMode(role.role), m)}
            settingKey={SPECIALIST_KEYS.maxMode(role.role)}
            inline
          />
        </div>
      ) : null}
    </div>
  );
}

export interface SpecialistsPanelProps extends SettingsFormProps {
  roles: readonly SpecialistRole[];
  /** Allowlisted model refs (`models.list`) for the per-role picker. */
  models?: readonly string[];
  /** `usage.monthlyBudgetUsd`, for the cap's default (half of it). */
  monthlyBudgetUsd?: number | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Roles open on their editor (stories). */
  openRoles?: readonly string[];
}

/** Settings → Specialists, presentational: the global limits, then one row per role. */
export function SpecialistsPanel({
  values,
  onChange,
  needsApproval,
  roles,
  models = [],
  monthlyBudgetUsd = null,
  loading = false,
  error = null,
  onRetry,
  openRoles = [],
}: SpecialistsPanelProps): ReactElement {
  const id = useId();
  const cap = values[SPECIALIST_KEYS.monthlyCapUsd];
  const capValue = typeof cap === "number" && cap > 0 ? cap : undefined;
  return (
    <SectionFrame
      title={t("settings.specialists.title")}
      description={t("settings.specialists.description")}
      needsApproval={needsApproval}
    >
      <LoadGate
        label={t("settings.specialists.title")}
        loading={loading}
        error={error}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title={t("settings.specialists.all")}>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <label htmlFor={`${id}-concurrent`} className="text-body text-label-primary">
                  {t("settings.specialists.concurrent")}
                </label>
                <p className="text-callout text-label-secondary">
                  {t("settings.specialists.concurrentHint")}
                </p>
              </div>
              <NativeSelect
                id={`${id}-concurrent`}
                value={String(num(values, SPECIALIST_KEYS.maxConcurrent, 3))}
                onChange={(e) => onChange(SPECIALIST_KEYS.maxConcurrent, Number(e.target.value))}
              >
                {CONCURRENCY.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <SettingHint settingKey={SPECIALIST_KEYS.maxConcurrent} />
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-0 flex-[2] flex-col">
                <span className="text-body text-label-primary">
                  {t("settings.specialists.monthlyCap")}
                </span>
                <p className="text-callout text-label-secondary">
                  {t("settings.specialists.monthlyCapHint", {
                    budget:
                      monthlyBudgetUsd != null && monthlyBudgetUsd > 0
                        ? formatUsd(monthlyBudgetUsd / 2)
                        : "none",
                  })}
                </p>
              </div>
              <div className="w-32">
                <NumberField
                  label={t("settings.specialists.budgetCost")}
                  value={capValue}
                  step={5}
                  onCommit={(v) => onChange(SPECIALIST_KEYS.monthlyCapUsd, v ?? null)}
                />
              </div>
            </div>
            <SettingHint settingKey={SPECIALIST_KEYS.monthlyCapUsd} />
          </div>
          <SwitchField
            label={t("settings.specialists.showInFeed")}
            description={t("settings.specialists.showInFeedHint")}
            checked={bool(values, SPECIALIST_KEYS.showInFeed, false)}
            onChange={(v) => onChange(SPECIALIST_KEYS.showInFeed, v)}
          />
        </Group>
        <Group
          title={t("settings.specialists.roles")}
          description={t("settings.specialists.rolesHint")}
        >
          {roles.length === 0 ? (
            <p className="text-callout text-label-secondary">{t("settings.specialists.empty")}</p>
          ) : (
            roles.map((role) => (
              <RoleRow
                key={role.role}
                role={role}
                values={values}
                onChange={onChange}
                models={models}
                defaultOpen={openRoles.includes(role.role)}
              />
            ))
          )}
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

/** Connected: `settings.*` for the values, `specialists.list` for the roles, `models.list`. */
export function SpecialistsSection(): ReactElement {
  const form = useSettingsForm();
  const specialists = useSpecialistRoles();
  const modelsList = useGatewayQuery("models.list", {});
  const models = (modelsList.data?.providers ?? []).flatMap((p) => p.models.map((m) => m.ref));
  const budget = form.values["usage.monthlyBudgetUsd"];
  return (
    <div className="flex flex-col gap-3">
      <SpecialistsPanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        roles={specialists.roles}
        models={models}
        monthlyBudgetUsd={typeof budget === "number" ? budget : null}
        loading={
          (form.loading && Object.keys(form.values).length === 0) ||
          (specialists.loading && specialists.roles.length === 0)
        }
        error={form.error ?? specialists.error}
        onRetry={() => {
          form.reload();
          specialists.reload();
        }}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
