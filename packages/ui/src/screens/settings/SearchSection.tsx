import {
  type AppleLlmStatus,
  SEARCH_MODEL_ENGINE_KEY,
  type SearchModelEngine,
} from "@psyche/protocol";
import type { ReactElement } from "react";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { useSlots } from "../../slots.tsx";
import { appleReason, appleState } from "./apple-status.ts";
import { SearchSourcesSettingsGroup } from "./SearchSourcesSettings.tsx";
import { SemanticSearchSettingsGroup } from "./SemanticSearchSettings.tsx";
import {
  Advanced,
  Group,
  LoadGate,
  RadioField,
  SectionFrame,
  type SettingsFormProps,
  StatusChip,
  useSettingsForm,
} from "./shared.tsx";
import { WebSearchSettingsGroup } from "./WebSearchSettings.tsx";

/**
 * Settings → Connectors & sources → Search (settings-2026): the one home for what Psyche searches
 * and how. These groups used to sit at the bottom of Model & providers, far from the sources they
 * index; Everything memory links here instead of repeating them.
 */

/**
 * Which model does the search jobs that read your text (reading a question, context cards,
 * rerank): the utility model, or Apple's on-device model (#1115). Shown only when a Mac helper that
 * offers it is connected; when the on-device model cannot run those jobs are skipped, never sent
 * to the cloud instead, so a chosen-but-unavailable model is the one amber thing here.
 */
export function SearchModelGroup({
  status,
  values,
  onChange,
}: Pick<SettingsFormProps, "values" | "onChange"> & {
  status: AppleLlmStatus | null;
}): ReactElement | null {
  const { remoteHost } = useSlots();
  if (status === null || !status.helperConnected) return null;
  const engine: SearchModelEngine =
    values[SEARCH_MODEL_ENGINE_KEY] === "apple" ? "apple" : "utility";
  const state = appleState(status);
  const reason = appleReason(status);
  return (
    <Group
      title={t("settings.searchModel.title")}
      description={t("settings.searchModel.description")}
    >
      <RadioField<SearchModelEngine>
        label={t("settings.key.search.model.engine")}
        hideLabel
        value={engine}
        settingKey={SEARCH_MODEL_ENGINE_KEY}
        onChange={(v) => onChange(SEARCH_MODEL_ENGINE_KEY, v)}
        options={[
          {
            value: "utility",
            label: t("settings.searchModel.utility"),
            hint: t("settings.searchModel.utilityHint"),
          },
          {
            value: "apple",
            label: t("settings.searchModel.apple"),
            hint: t("settings.searchModel.appleHint", {
              k: Math.max(1, Math.round(status.contextTokens / 1024)),
            }),
            // Off or unavailable: it cannot be picked. If it was chosen earlier it stays shown as
            // chosen (and skipped, never sent to the cloud) so the owner can see and undo it.
            disabled: !status.available,
          },
        ]}
      />
      <div role="status" className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-callout text-label-secondary">
            {t("settings.searchModel.appleName")}
          </span>
          <StatusChip
            tone={engine === "apple" || state.tone !== "approval" ? state.tone : "neutral"}
          >
            {state.text}
          </StatusChip>
        </div>
        {reason === undefined ? null : (
          <p className="text-callout text-label-secondary" data-testid="apple-reason">
            {reason}
            {engine === "apple" ? ` ${t("settings.searchModel.apple.whySkipped")}` : ""}
          </p>
        )}
      </div>
      {remoteHost === undefined ? null : (
        <p className="text-callout text-label-secondary" data-testid="apple-host-note">
          {t("settings.searchModel.apple.host", { host: remoteHost })}
        </p>
      )}
    </Group>
  );
}

function ConnectedSearchModelGroup(
  props: Pick<SettingsFormProps, "values" | "onChange">,
): ReactElement | null {
  const apple = useGatewayQuery("models.appleStatus", {});
  // A Gateway without it (or no Mac helper) shows nothing: the utility model is all there is.
  return <SearchModelGroup {...props} status={apple.data ?? null} />;
}

export interface SearchPanelProps extends Pick<SettingsFormProps, "values" | "onChange"> {
  needsApproval?: ReadonlySet<string>;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Overrides the live on-device model status (stories, tests); null hides the choice. */
  appleStatus?: AppleLlmStatus | null;
}

/** The presentational section; `SearchSection` feeds it from the Gateway. */
export function SearchPanel({
  values,
  onChange,
  needsApproval,
  loading = false,
  error = null,
  onRetry,
  appleStatus,
}: SearchPanelProps): ReactElement {
  return (
    <SectionFrame
      title={t("settings.search.title")}
      description={t("settings.search.description")}
      needsApproval={needsApproval}
    >
      <LoadGate
        label={t("settings.search.title")}
        loading={loading}
        error={error}
        {...(onRetry ? { onRetry } : {})}
      >
        <SearchSourcesSettingsGroup values={values} onChange={onChange} />
        <SemanticSearchSettingsGroup values={values} onChange={onChange} />
        <WebSearchSettingsGroup values={values} onChange={onChange} />
        <Advanced description={t("settings.search.advancedHint")}>
          {appleStatus === undefined ? (
            <ConnectedSearchModelGroup values={values} onChange={onChange} />
          ) : (
            <SearchModelGroup status={appleStatus} values={values} onChange={onChange} />
          )}
        </Advanced>
      </LoadGate>
    </SectionFrame>
  );
}

export function SearchSection(): ReactElement {
  const form = useSettingsForm();
  return (
    <SearchPanel
      values={form.values}
      onChange={form.onChange}
      needsApproval={form.needsApproval}
      loading={form.loading && Object.keys(form.values).length === 0}
      error={form.error}
      onRetry={form.reload}
    />
  );
}
