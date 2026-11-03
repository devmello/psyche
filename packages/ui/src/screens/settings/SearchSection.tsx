import {
  type AppleLlmStatus,
  SEARCH_MODEL_ENGINE_KEY,
  type SearchModelEngine,
} from "@psyche/protocol";
import type { ReactElement } from "react";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
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
  type Tone,
  useSettingsForm,
} from "./shared.tsx";
import { WebSearchSettingsGroup } from "./WebSearchSettings.tsx";

/**
 * Settings → Connectors & sources → Search (settings-2026): the one home for what Psyche searches
 * and how. These groups used to sit at the bottom of Model & providers, far from the sources they
 * index; Everything memory links here instead of repeating them.
 */

/** Why the on-device model cannot run, in plain words, and how loud to say it. */
function appleState(status: AppleLlmStatus): { text: string; tone: Tone } {
  if (status.available) return { text: t("settings.searchModel.apple.ready"), tone: "success" };
  switch (status.reason) {
    case "apple_intelligence_not_enabled":
      return { text: t("settings.searchModel.apple.needsAi"), tone: "approval" };
    case "model_not_ready":
      return { text: t("settings.searchModel.apple.notReady"), tone: "info" };
    case "unsupported_os":
    case "device_not_eligible":
      return { text: t("settings.searchModel.apple.notOnThisMac"), tone: "neutral" };
    default:
      return { text: t("settings.searchModel.apple.unavailable"), tone: "neutral" };
  }
}

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
  if (status === null || !status.helperConnected) return null;
  const engine: SearchModelEngine =
    values[SEARCH_MODEL_ENGINE_KEY] === "apple" ? "apple" : "utility";
  const state = appleState(status);
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
            hint: t("settings.searchModel.appleHint", { tokens: status.contextTokens }),
            // Choosing it stays possible while it is getting ready; not on a Mac that can't.
            disabled:
              !status.available &&
              engine !== "apple" &&
              (status.reason === "unsupported_os" || status.reason === "device_not_eligible"),
          },
        ]}
      />
      <div role="status" className="flex flex-wrap items-center gap-2">
        <span className="text-callout text-label-secondary">{t("settings.searchModel.apple")}</span>
        <StatusChip tone={engine === "apple" || state.tone !== "approval" ? state.tone : "neutral"}>
          {state.text}
        </StatusChip>
      </div>
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
