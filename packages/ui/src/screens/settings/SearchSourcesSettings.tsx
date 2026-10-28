import type { SearchSourceId, SearchSourceStatus, SearchSourcesStatus } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useSearchSources } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { formatRelative } from "../../lib/format.ts";
import { Group, StatusChip, SwitchField } from "./shared.tsx";

/**
 * Settings → Search sources (docs/design/search-roadmap-2026.md §2): the owner chooses which
 * local sources Psyche reads into the search index. Every one is off until switched on; Messages
 * says plainly what it reads. Each row shows its item count, last indexed time and size, and a
 * Rebuild. "Never index" keeps contacts and folders out.
 */

const HINT = {
  mail: "settings.searchSources.hint.mail",
  messages: "settings.searchSources.hint.messages",
  notes: "settings.searchSources.hint.notes",
  calendar: "settings.searchSources.hint.calendar",
  reminders: "settings.searchSources.hint.reminders",
  files: "settings.searchSources.hint.files",
} as const satisfies Record<SearchSourceId, string>;

const kb = (bytes: number) =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} kB`;

/** One line saying what a source is doing now. */
export function sourceStateText(s: SearchSourceStatus): {
  text: string;
  tone: "success" | "danger" | "info" | "neutral" | "approval";
} {
  switch (s.state) {
    case "off":
      return { text: t("settings.searchSources.state.off"), tone: "neutral" };
    case "unavailable":
      return {
        text: t("settings.searchSources.state.unavailable", { why: s.detail ?? "" }),
        tone: "approval",
      };
    case "error":
      return {
        text: t("settings.searchSources.state.error", { why: s.detail ?? "" }),
        tone: "danger",
      };
    case "indexing":
      return {
        text: t("settings.searchSources.state.indexing", { n: s.items }),
        tone: "info",
      };
    default:
      return { text: t("settings.searchSources.state.idle", { n: s.items }), tone: "success" };
  }
}

const split = (v: string) =>
  v
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter((x) => x !== "");

export function SearchSourcesSettingsGroup({
  status,
  onConfigure,
  onRebuild,
  now = Date.now(),
}: {
  /** Overrides the live status (stories, tests). */
  status?: SearchSourcesStatus;
  onConfigure?: (p: {
    source?: SearchSourceId;
    enabled?: boolean;
    processing?: "cloud" | "local" | "none";
    exclude?: { contacts?: string[]; folders?: string[] };
  }) => void | Promise<void>;
  onRebuild?: (source: SearchSourceId) => void | Promise<void>;
  now?: number;
}): ReactElement {
  const live = useSearchSources();
  const data = status ?? live.status;
  const configure = onConfigure ?? ((p) => live.configure(p));
  const rebuild = onRebuild ?? ((id) => live.rebuild(id));
  const [contacts, setContacts] = useState<string | undefined>();
  const [folders, setFolders] = useState<string | undefined>();
  return (
    <Group
      title={t("settings.searchSources.title")}
      description={t("settings.searchSources.description")}
    >
      {(data?.sources ?? []).map((s) => {
        const line = sourceStateText(s);
        return (
          <SwitchField
            key={s.id}
            label={s.label}
            description={t(HINT[s.id])}
            checked={s.enabled}
            onChange={(v) => void configure({ source: s.id, enabled: v })}
          >
            <div role="status" className="flex flex-wrap items-center gap-2 pt-1">
              <StatusChip tone={line.tone}>{line.text}</StatusChip>
              {s.enabled ? (
                <span className="text-caption text-label-secondary">
                  {s.lastIndexedAt === undefined
                    ? t("settings.searchSources.neverIndexed")
                    : t("settings.searchSources.lastIndexed", {
                        when: formatRelative(new Date(s.lastIndexedAt).toISOString(), now),
                      })}
                  {" · "}
                  {kb(s.textBytes)}
                </span>
              ) : null}
              {s.enabled ? (
                <Button
                  type="button"
                  variant="plain"
                  size="sm"
                  aria-label={t("settings.searchSources.rebuildLabel", { source: s.label })}
                  onClick={() => void rebuild(s.id)}
                >
                  {t("settings.searchSources.rebuild")}
                </Button>
              ) : null}
            </div>
            {s.enabled ? (
              <label className="flex items-center gap-2 pt-1 text-caption text-label-secondary">
                {t("settings.searchSources.processing")}
                <select
                  className="rounded-md border border-separator bg-transparent px-1 py-0.5"
                  aria-label={t("settings.searchSources.processingLabel", { source: s.label })}
                  value={s.processing}
                  onChange={(e) =>
                    void configure({
                      source: s.id,
                      processing: e.target.value as "cloud" | "local" | "none",
                    })
                  }
                >
                  <option value="cloud">{t("settings.searchSources.processing.cloud")}</option>
                  <option value="local">{t("settings.searchSources.processing.local")}</option>
                  <option value="none">{t("settings.searchSources.processing.none")}</option>
                </select>
              </label>
            ) : null}
          </SwitchField>
        );
      })}
      {data !== undefined ? (
        <div className="flex flex-col gap-2 pt-2">
          <label className="flex flex-col gap-1 text-body text-label-primary">
            {t("settings.searchSources.excludeContacts")}
            <input
              className="rounded-md border border-separator bg-transparent px-2 py-1 text-body"
              placeholder={t("settings.searchSources.excludeContactsHint")}
              value={contacts ?? data.exclude.contacts.join(", ")}
              onChange={(e) => setContacts(e.target.value)}
              onBlur={() => {
                if (contacts !== undefined)
                  void configure({ exclude: { contacts: split(contacts) } });
                setContacts(undefined);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-body text-label-primary">
            {t("settings.searchSources.excludeFolders")}
            <input
              className="rounded-md border border-separator bg-transparent px-2 py-1 text-body"
              placeholder="~/Documents/Private"
              value={folders ?? data.exclude.folders.join(", ")}
              onChange={(e) => setFolders(e.target.value)}
              onBlur={() => {
                if (folders !== undefined) void configure({ exclude: { folders: split(folders) } });
                setFolders(undefined);
              }}
            />
          </label>
          <p className="text-caption text-label-secondary">
            {t("settings.searchSources.indexSize", { size: kb(data.indexBytes) })}
          </p>
        </div>
      ) : null}
    </Group>
  );
}
