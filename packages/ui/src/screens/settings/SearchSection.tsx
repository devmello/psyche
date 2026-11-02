import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { SearchSourcesSettingsGroup } from "./SearchSourcesSettings.tsx";
import { SemanticSearchSettingsGroup } from "./SemanticSearchSettings.tsx";
import { LoadGate, SectionFrame, type SettingsFormProps, useSettingsForm } from "./shared.tsx";
import { WebSearchSettingsGroup } from "./WebSearchSettings.tsx";

/**
 * Settings → Connectors & sources → Search (settings-2026): the one home for what Psyche searches
 * and how. These groups used to sit at the bottom of Model & providers, far from the sources they
 * index; Everything memory links here instead of repeating them.
 */

export interface SearchPanelProps extends Pick<SettingsFormProps, "values" | "onChange"> {
  needsApproval?: ReadonlySet<string>;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

/** The presentational section; `SearchSection` feeds it from the Gateway. */
export function SearchPanel({
  values,
  onChange,
  needsApproval,
  loading = false,
  error = null,
  onRetry,
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
        <SearchSourcesSettingsGroup />
        <SemanticSearchSettingsGroup values={values} onChange={onChange} />
        <WebSearchSettingsGroup values={values} onChange={onChange} />
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
