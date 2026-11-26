import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import { modelLabel, providerInfoFromSummary, providersFromSettings } from "./ModelSection.tsx";
import { MODE_OPTIONS } from "./PermissionsSection.tsx";
import { pageOfPane, type SettingsPaneId } from "./settings-pages.ts";
import {
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
 * Settings → General's body, Essentials (docs/design/settings-2026.md §7): the three choices a
 * newcomer makes (model, how often it asks, memory), each with a safe default, written to the
 * same keys and calls as the detailed pane it names. Nothing here is the only place to change
 * it; "More" opens that pane.
 */

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
      {t("settings.essentials.openPlace", { place: label })}
    </Button>
  );
}

/**
 * A readable name for a model ref the provider gives no label for:
 * "anthropic/claude-sonnet-5-5" reads as "Claude Sonnet 5.5".
 */
export function readableModelName(ref: string): string {
  const words = ref
    .slice(ref.indexOf("/") + 1)
    .split(/[-_]/)
    .filter((word) => word.length > 0);
  // Version digits rejoin with a dot: "5-5" is 5.5, not "5 5".
  const parts: string[] = [];
  for (const word of words) {
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(word) && last !== undefined && /^\d+(\.\d+)*$/.test(last)) {
      parts[parts.length - 1] = `${last}.${word}`;
    } else {
      parts.push(word.charAt(0).toUpperCase() + word.slice(1));
    }
  }
  return parts.join(" ");
}

export function EssentialsPanel({
  values,
  onChange,
  persona,
  model,
  remembering,
  onRemember,
  busy = false,
  onOpen,
  needsApproval,
  loading = false,
  error = null,
  onRetry,
}: EssentialsPanelProps): ReactElement {
  return (
    <SectionFrame
      title={t("settings.page.general")}
      description={t("settings.essentials.description", { persona })}
      needsApproval={needsApproval}
    >
      <LoadGate
        label={t("settings.page.general")}
        loading={loading}
        error={error}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group
          title={t("settings.essentials.model.title")}
          actions={<More pane="model" label={pageOfPane("model").label} onOpen={onOpen} />}
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
              <span className="min-w-0 truncate text-body text-label-primary">
                {model.label ?? readableModelName(model.ref ?? "")}
              </span>
              {model.ready ? (
                <StatusChip tone="success">{t("settings.essentials.model.ready")}</StatusChip>
              ) : onOpen ? (
                <Button type="button" size="sm" onClick={() => onOpen("model")}>
                  {t("settings.essentials.model.addKey")}
                </Button>
              ) : null}
            </div>
          )}
        </Group>

        <Group
          title={t("settings.essentials.asks.title", { persona })}
          actions={
            <More pane="permissions" label={pageOfPane("permissions").label} onOpen={onOpen} />
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
          <p className="pt-2 text-callout text-label-secondary">
            {t("settings.essentials.fullAccessNote")}
          </p>
        </Group>

        <Group
          title={t("settings.essentials.memory.title")}
          actions={<More pane="learning" label={pageOfPane("learning").label} onOpen={onOpen} />}
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
