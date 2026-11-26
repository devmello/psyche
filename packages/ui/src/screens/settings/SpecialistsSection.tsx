import type { SpecialistRole } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
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
  SectionFrame,
  SettingHint,
  type SettingsFormProps,
  SwitchField,
  useSettingsForm,
} from "./shared.tsx";

/**
 * Settings → Specialists (docs/agent/specialists-2026.md §6.4). Admin keys, except Feed. A role's
 * budget and highest mode come from its skill definition; nothing reads an owner override, so
 * Settings does not offer one.
 */
export const SPECIALIST_KEYS = {
  maxConcurrent: "specialists.maxConcurrent",
  showInFeed: "specialists.showInFeed",
  enabled: (role: string) => `specialists.enabled.${role}`,
  model: (role: string) => `specialists.model.${role}`,
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
  budget: SpecialistRole["budget"];
  maxMode: Mode;
} {
  const model = values[SPECIALIST_KEYS.model(role.role)];
  return {
    enabled: bool(values, SPECIALIST_KEYS.enabled(role.role), role.enabled),
    model: typeof model === "string" && model !== "" ? model : (role.model ?? null),
    budget: role.budget,
    // A role's highest mode is never Full access (only the owner turns that on, in a chat).
    maxMode: (MODES as readonly string[]).includes(role.maxMode) ? (role.maxMode as Mode) : "auto",
  };
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
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={`${id}-edit`}
          aria-label={t("settings.specialists.editLabel", { role: role.label })}
          className="shrink-0"
        >
          {open ? t("settings.specialists.done") : t("settings.specialists.edit")}
        </Button>
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
        </div>
      ) : null}
    </div>
  );
}

export interface SpecialistsPanelProps extends SettingsFormProps {
  roles: readonly SpecialistRole[];
  /** Allowlisted model refs (`models.list`) for the per-role picker. */
  models?: readonly string[];
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
  loading = false,
  error = null,
  onRetry,
  openRoles = [],
}: SpecialistsPanelProps): ReactElement {
  const id = useId();
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
        <Group
          title={t("settings.specialists.all")}
          description={t("settings.specialists.allHint")}
        >
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
  return (
    <div className="flex flex-col gap-3">
      <SpecialistsPanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        roles={specialists.roles}
        models={models}
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
