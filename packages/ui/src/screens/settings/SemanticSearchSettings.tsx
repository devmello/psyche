import type { SearchSemanticStatus } from "@psyche/protocol";
import type { ReactElement } from "react";
import { useSearchIndexStatus } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import {
  bool,
  Group,
  RadioField,
  type SettingsValues,
  StatusChip,
  SwitchField,
} from "./shared.tsx";

/**
 * Search, under Model & providers (docs/design/search-2026.md §3): "Semantic search (on-device)"
 * finds things by meaning as well as by words. The built-in engine downloads a small model the
 * first time; "my local model server" uses the embedding role (Ollama, LM Studio). Live status
 * comes from `search.status` / `search.status.updated`.
 */

export const SEMANTIC_SEARCH_KEYS = {
  enabled: "search.semantic.enabled",
  engine: "search.semantic.engine",
} as const;

type Engine = "builtin" | "router";

const mb = (bytes: number) => Math.round(bytes / 1_000_000);

/** One line saying what semantic search is doing now. */
export function semanticStatusText(s: SearchSemanticStatus | undefined): {
  text: string;
  tone: "success" | "danger" | "info" | "neutral";
} {
  switch (s?.state) {
    case undefined:
    case "off":
      return { text: t("settings.semanticSearch.state.off"), tone: "neutral" };
    case "downloading":
      return {
        text:
          s.totalBytes !== undefined && s.totalBytes > 0
            ? t("settings.semanticSearch.state.downloading", {
                received: mb(s.receivedBytes ?? 0),
                total: mb(s.totalBytes),
              })
            : t("settings.semanticSearch.state.starting"),
        tone: "info",
      };
    case "loading":
      return { text: t("settings.semanticSearch.state.starting"), tone: "info" };
    case "indexing":
      return {
        text: t("settings.semanticSearch.state.indexing", {
          done: s.done ?? 0,
          total: Math.max(s.total ?? 0, s.done ?? 0),
        }),
        tone: "info",
      };
    case "ready":
      return {
        text: t("settings.semanticSearch.state.ready", { n: s.vectors ?? 0 }),
        tone: "success",
      };
    case "blocked":
      return {
        text:
          s.blocked === "cloud_not_allowed"
            ? t("settings.semanticSearch.state.cloudBlocked")
            : t("settings.semanticSearch.state.noModel"),
        tone: "danger",
      };
    case "error":
      return {
        text: t("settings.semanticSearch.state.error", { reason: s.error ?? "" }),
        tone: "danger",
      };
  }
}

export function SemanticSearchSettingsGroup({
  values,
  onChange,
  status,
}: {
  values: SettingsValues;
  onChange: (key: string, value: unknown) => void;
  /** Overrides the live status (stories, tests). */
  status?: SearchSemanticStatus;
}): ReactElement {
  const live = useSearchIndexStatus();
  const semantic = status ?? live.status?.semantic;
  const enabled = bool(values, SEMANTIC_SEARCH_KEYS.enabled, false);
  const engine: Engine = values[SEMANTIC_SEARCH_KEYS.engine] === "router" ? "router" : "builtin";
  const line = semanticStatusText(enabled ? semantic : undefined);
  return (
    <Group
      title={t("settings.semanticSearch.title")}
      description={t("settings.semanticSearch.description")}
    >
      <SwitchField
        label={t("settings.key.search.semantic.enabled")}
        description={t("settings.semanticSearch.enabledHint")}
        checked={enabled}
        onChange={(v) => onChange(SEMANTIC_SEARCH_KEYS.enabled, v)}
        settingKey={SEMANTIC_SEARCH_KEYS.enabled}
      >
        <div role="status" className="flex items-center gap-2 pt-1">
          <StatusChip tone={line.tone}>{line.text}</StatusChip>
        </div>
      </SwitchField>
      {enabled ? (
        <RadioField<Engine>
          label={t("settings.key.search.semantic.engine")}
          value={engine}
          settingKey={SEMANTIC_SEARCH_KEYS.engine}
          onChange={(v) => onChange(SEMANTIC_SEARCH_KEYS.engine, v)}
          options={[
            {
              value: "builtin",
              label: t("settings.semanticSearch.engine.builtin"),
              hint: t("settings.semanticSearch.engine.builtinHint"),
            },
            {
              value: "router",
              label: t("settings.semanticSearch.engine.router"),
              hint: t("settings.semanticSearch.engine.routerHint"),
            },
          ]}
        />
      ) : null}
    </Group>
  );
}
