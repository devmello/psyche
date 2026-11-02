import { NOTIFICATION_SETTING_DEFAULTS, type SearchSourceId } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery, useSearchSources } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import { DAILY_DEFAULTS } from "./DailySection.tsx";
import { modelLabel, providerInfoFromSummary, providersFromSettings } from "./ModelSection.tsx";
import { MODE_OPTIONS } from "./PermissionsSection.tsx";
import type { SettingsPaneId } from "./settings-pages.ts";
import {
  bool,
  ErrorNotice,
  Group,
  LoadGate,
  messageOf,
  RadioField,
  SectionFrame,
  type SettingsFormProps,
  StatusChip,
  SwitchField,
  str,
  useSettingsForm,
} from "./shared.tsx";

/**
 * Settings → Essentials (docs/design/settings-2026.md §7): the handful of choices a newcomer
 * makes, each with a safe default, written to the same keys and calls as the detailed pane it
 * names. Nothing here is the only place to change it; "More" opens that pane.
 */

/** The sources a newcomer decides on; Browser pages and Transcripts stay in Search. */
const READ_SOURCES: readonly SearchSourceId[] = [
  "mail",
  "messages",
  "notes",
  "calendar",
  "reminders",
  "files",
];

export interface EssentialsModel {
  /** The primary model's ref, or null when none is picked yet. */
  ref: string | null;
  label: string | null;
  /** Its provider answers: a key is stored, or it runs on this Mac. */
  ready: boolean;
}

export interface EssentialsPanelProps extends Pick<SettingsFormProps, "values" | "onChange"> {
  persona: string;
  model: EssentialsModel;
  sources: readonly { id: SearchSourceId; label: string; enabled: boolean }[];
  onSource: (id: SearchSourceId, enabled: boolean) => void;
  /** Memory is on (not paused). */
  remembering: boolean;
  onRemember?: (on: boolean) => void;
  busy?: boolean;
  /** Opens the detailed pane for a group ("More"). */
  onOpen?: (pane: SettingsPaneId) => void;
  needsApproval?: ReadonlySet<string>;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

function More({
  pane,
  label,
  onOpen,
}: {
  pane: SettingsPaneId;
  label: string;
  onOpen: ((pane: SettingsPaneId) => void) | undefined;
}): ReactElement | null {
  if (!onOpen) return null;
  return (
    <Button
      type="button"
      variant="plain"
      size="sm"
      aria-label={t("settings.essentials.moreIn", { place: label })}
      onClick={() => onOpen(pane)}
    >
      {t("settings.essentials.more")}
    </Button>
  );
}

export function EssentialsPanel({
  values,
  onChange,
  persona,
  model,
  sources,
  onSource,
  remembering,
  onRemember,
  busy = false,
  onOpen,
  needsApproval,
  loading = false,
  error = null,
  onRetry,
}: EssentialsPanelProps): ReactElement {
  const quiet = bool(
    values,
    "notifications.quietHours.enabled",
    NOTIFICATION_SETTING_DEFAULTS["notifications.quietHours.enabled"],
  );
  const from = str(
    values,
    "notifications.quietHours.start",
    NOTIFICATION_SETTING_DEFAULTS["notifications.quietHours.start"],
  );
  const until = str(
    values,
    "notifications.quietHours.end",
    NOTIFICATION_SETTING_DEFAULTS["notifications.quietHours.end"],
  );
  const brief = bool(values, "daily.brief.enabled", DAILY_DEFAULTS["daily.brief.enabled"]);
  const briefAt = str(values, "daily.brief.time", DAILY_DEFAULTS["daily.brief.time"]);
  return (
    <SectionFrame
      title={t("settings.essentials.title")}
      description={t("settings.essentials.description", { persona })}
      needsApproval={needsApproval}
    >
      <LoadGate
        label={t("settings.essentials.title")}
        loading={loading}
        error={error}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group
          title={t("settings.essentials.model.title")}
          actions={<More pane="model" label={t("settings.nav.model")} onOpen={onOpen} />}
        >
          {model.ref === null ? (
            // The one thing that needs the owner before anything works: amber, and the one
            // accent-filled button on the page.
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <StatusChip tone="approval">{t("settings.essentials.model.none")}</StatusChip>
                <p className="text-callout text-label-secondary">
                  {t("settings.essentials.model.noneHint", { persona })}
                </p>
              </div>
              {onOpen ? (
                <Button type="button" size="sm" onClick={() => onOpen("model")}>
                  {t("settings.essentials.model.setUp")}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-body text-label-primary">
                {t("settings.essentials.model.thinksWith", { persona })}
              </span>
              <code className="min-w-0 truncate font-mono text-callout text-label-primary">
                {model.label ?? model.ref}
              </code>
              {model.ready ? (
                <StatusChip tone="success">{t("settings.essentials.model.ready")}</StatusChip>
              ) : (
                <StatusChip tone="approval">{t("settings.essentials.model.noKey")}</StatusChip>
              )}
            </div>
          )}
        </Group>

        <Group
          title={t("settings.essentials.read.title", { persona })}
          description={t("settings.essentials.read.hint")}
          actions={<More pane="search" label={t("settings.nav.search")} onOpen={onOpen} />}
        >
          {sources.map((s) => (
            <SwitchField
              key={s.id}
              label={s.label}
              checked={s.enabled}
              onChange={(on) => onSource(s.id, on)}
            />
          ))}
        </Group>

        <Group
          title={t("settings.essentials.asks.title", { persona })}
          actions={
            <More pane="permissions" label={t("settings.nav.permissions")} onOpen={onOpen} />
          }
        >
          <RadioField
            label={t("settings.key.permissions.mode")}
            hideLabel
            value={str(values, "permissions.mode", "balanced")}
            options={MODE_OPTIONS}
            settingKey="permissions.mode"
            onChange={(v) => onChange("permissions.mode", v)}
          />
        </Group>

        <Group
          title={t("settings.essentials.interrupt.title", { persona })}
          actions={
            <More pane="notifications" label={t("settings.nav.notifications")} onOpen={onOpen} />
          }
        >
          <SwitchField
            label={t("settings.key.notifications.quietHours.enabled")}
            description={t("settings.essentials.interrupt.quietHint", { from, until })}
            settingKey="notifications.quietHours.enabled"
            checked={quiet}
            onChange={(on) => onChange("notifications.quietHours.enabled", on)}
          />
          <SwitchField
            label={t("settings.key.daily.brief.enabled")}
            description={t("settings.essentials.interrupt.briefHint", { time: briefAt })}
            settingKey="daily.brief.enabled"
            checked={brief}
            onChange={(on) => onChange("daily.brief.enabled", on)}
          />
        </Group>

        <Group
          title={t("settings.essentials.memory.title")}
          actions={<More pane="learning" label={t("settings.nav.learning")} onOpen={onOpen} />}
        >
          <SwitchField
            label={t("settings.essentials.memory.remember", { persona })}
            description={t("settings.essentials.memory.rememberHint", { persona })}
            checked={remembering}
            disabled={onRemember === undefined || busy}
            onChange={(on) => onRemember?.(on)}
          />
        </Group>

        <p className="px-1 text-callout text-label-secondary">{t("settings.essentials.rest")}</p>
      </LoadGate>
    </SectionFrame>
  );
}

/** Essentials fed from the Gateway: settings, the model roles, search sources and memory. */
export function EssentialsSection({
  onOpen,
}: {
  onOpen?: (pane: SettingsPaneId) => void;
}): ReactElement {
  const form = useSettingsForm();
  const persona = usePersona();
  const call = useCall();
  const { navigate } = useSlots();
  const models = useGatewayQuery("models.list", {});
  const memory = useGatewayQuery("memory.status", {});
  const search = useSearchSources();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // As Model & providers reads it: the live list when the Gateway has one, else the settings.
  const live = models.data !== undefined && models.data.providers.length > 0;
  const providers = live
    ? (models.data?.providers ?? []).map(providerInfoFromSummary)
    : providersFromSettings(form.values);
  const ref =
    (live ? models.data?.roles.primary : undefined) ??
    (str(form.values, "models.primary", "") || null);
  const provider = ref === null ? undefined : providers.find((p) => ref.startsWith(`${p.id}/`));
  const entry = provider?.models.find((m) => m.ref === ref);
  const model: EssentialsModel = {
    ref,
    label: entry === undefined ? null : modelLabel(entry),
    ready: provider?.status === "ok",
  };
  const sources = READ_SOURCES.flatMap((id) => {
    const s = search.status?.sources.find((x) => x.id === id);
    return s === undefined ? [] : [{ id, label: s.label, enabled: s.enabled }];
  });
  const open =
    onOpen ?? (navigate ? (pane: SettingsPaneId) => navigate(`/settings/${pane}`) : undefined);
  const fail = (err: unknown) => setFailed(messageOf(err));

  return (
    <div className="flex flex-col gap-3">
      <EssentialsPanel
        values={form.values}
        onChange={form.onChange}
        persona={persona.name}
        model={model}
        sources={sources}
        onSource={(source, enabled) => void search.configure({ source, enabled }).catch(fail)}
        remembering={memory.data?.paused !== true}
        onRemember={(on) => {
          setBusy(true);
          setFailed(null);
          call("memory.pause", { paused: !on })
            .then(() => memory.reload())
            .catch(fail)
            .finally(() => setBusy(false));
        }}
        busy={busy}
        {...(open ? { onOpen: open } : {})}
        needsApproval={form.needsApproval}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
      />
      {failed ? <ErrorNotice what={failed} did="" /> : null}
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
