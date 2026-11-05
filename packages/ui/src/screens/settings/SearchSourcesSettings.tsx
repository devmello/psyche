import type { SearchSourceId, SearchSourceStatus, SearchSourcesStatus } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useSearchSources } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { formatRelative } from "../../lib/format.ts";
import { isWindows } from "../../lib/platform.ts";
import { bool, Group, type SettingsValues, StatusChip, SwitchField } from "./shared.tsx";

/**
 * Settings → Search sources (docs/design/search-roadmap-2026.md §2): the owner chooses which
 * local sources Psyche reads into the search index. Every one is off until switched on; Messages
 * says plainly what it reads. Each row shows its item count, last indexed time and size, and a
 * Rebuild that says what it is doing (busy, how far it has read, done) or why it cannot. A source
 * switched on here is also one memory learns from unless opted out (Memory → Sources). "Never
 * index" keeps contacts and folders out.
 */

/** What a Rebuild press has done: the call is out, it is reading in the background, or it was refused. */
type Rebuild = { phase: "calling" } | { phase: "watching" } | { phase: "failed"; why: string };

const HINT = {
  mail: "settings.searchSources.hint.mail",
  messages: "settings.searchSources.hint.messages",
  notes: "settings.searchSources.hint.notes",
  calendar: "settings.searchSources.hint.calendar",
  reminders: "settings.searchSources.hint.reminders",
  contacts: "settings.searchSources.hint.contacts",
  files: "settings.searchSources.hint.files",
  browser: "settings.searchSources.hint.browser",
  transcripts: "settings.searchSources.hint.transcripts",
  memory: "settings.searchSources.hint.memory",
} as const satisfies Record<SearchSourceId, string>;

/** Mac apps: a Windows Gateway does not list them, and an older one's rows are not shown. */
const MAC_ONLY: ReadonlySet<SearchSourceId> = new Set(["notes", "messages"]);

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

/** What to say under a source after Rebuild was pressed; nothing before, and nothing once it is stale. */
function rebuildNote(
  s: SearchSourceStatus,
  rb: Rebuild | undefined,
): { text: string; tone: "success" | "danger" | "info" } | undefined {
  if (rb === undefined) return undefined;
  if (rb.phase === "calling")
    return {
      text: t("settings.searchSources.rebuild.starting", { source: s.label }),
      tone: "info",
    };
  if (rb.phase === "failed")
    return {
      text: t("settings.searchSources.rebuild.failed", { source: s.label, why: rb.why }),
      tone: "danger",
    };
  if (s.state === "indexing")
    return {
      text: t("settings.searchSources.rebuild.progress", { source: s.label, n: s.items }),
      tone: "info",
    };
  if (s.state === "idle")
    return {
      text: t("settings.searchSources.rebuild.done", { source: s.label, n: s.items }),
      tone: "success",
    };
  // Off, unavailable or failed: the row's own status line already says so.
  return undefined;
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
  values,
  onChange,
  now = Date.now(),
}: {
  /** The settings values and writer, for "Index on battery" (a plain setting, not a source). */
  values?: SettingsValues;
  onChange?: (key: string, value: unknown) => void;
  /** Overrides the live status (stories, tests). */
  status?: SearchSourcesStatus;
  onConfigure?: (p: {
    source?: SearchSourceId;
    enabled?: boolean;
    processing?: "cloud" | "local" | "none";
    agent?: boolean;
    ocr?: boolean;
    exclude?: { contacts?: string[]; folders?: string[] };
  }) => void | Promise<void>;
  onRebuild?: (source: SearchSourceId) => unknown;
  now?: number;
}): ReactElement {
  const live = useSearchSources();
  const data = status ?? live.status;
  const configure = onConfigure ?? ((p) => live.configure(p));
  const rebuild = onRebuild ?? ((id) => live.rebuild(id));
  const [rebuilds, setRebuilds] = useState<Record<string, Rebuild>>({});
  const [contacts, setContacts] = useState<string | undefined>();
  const [folders, setFolders] = useState<string | undefined>();
  const press = async (id: SearchSourceId) => {
    setRebuilds((r) => ({ ...r, [id]: { phase: "calling" } }));
    try {
      await rebuild(id);
      setRebuilds((r) => ({ ...r, [id]: { phase: "watching" } }));
    } catch (err) {
      setRebuilds((r) => ({ ...r, [id]: { phase: "failed", why: describeError(err) } }));
    }
  };
  return (
    <Group
      title={t("settings.searchSources.title")}
      description={t("settings.searchSources.description")}
    >
      {onChange === undefined ? null : (
        <SwitchField
          label={t("settings.key.search.runOnBattery")}
          description={t("settings.searchSources.runOnBatteryHint")}
          checked={bool(values ?? {}, "search.runOnBattery", false)}
          onChange={(v) => onChange("search.runOnBattery", v)}
          settingKey="search.runOnBattery"
        />
      )}
      {(data?.sources ?? [])
        .filter((s) => !(isWindows() && MAC_ONLY.has(s.id)))
        .map((s) => {
          const line = sourceStateText(s);
          const rb = rebuilds[s.id];
          const reading = rb?.phase === "watching" && s.state === "indexing";
          const busy = rb?.phase === "calling" || reading;
          const note = rebuildNote(s, rb);
          return (
            <SwitchField
              key={s.id}
              label={s.label}
              description={t(HINT[s.id])}
              checked={s.enabled}
              // Greyed, with the reason, until it can be switched on (it can always be switched off).
              disabled={!s.enabled && s.cannotEnable !== undefined}
              onChange={(v) => void configure({ source: s.id, enabled: v })}
            >
              {!s.enabled && s.cannotEnable !== undefined ? (
                <p role="status" className="text-caption text-label-secondary">
                  {t("settings.searchSources.cannotEnable", { why: s.cannotEnable })}
                </p>
              ) : null}
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
                <Button
                  type="button"
                  variant="plain"
                  size="sm"
                  disabled={!s.enabled || busy}
                  aria-label={t("settings.searchSources.rebuildLabel", { source: s.label })}
                  {...(s.enabled
                    ? {}
                    : {
                        title: t("settings.searchSources.rebuild.turnOnFirst", { source: s.label }),
                      })}
                  onClick={() => void press(s.id)}
                >
                  {busy
                    ? t("settings.searchSources.rebuilding")
                    : t("settings.searchSources.rebuild")}
                </Button>
              </div>
              {note === undefined ? null : (
                <div role="status" data-testid={`rebuild-${s.id}`} className="pt-1">
                  <StatusChip tone={note.tone}>{note.text}</StatusChip>
                </div>
              )}
              {s.enabled ? (
                <label className="flex items-center gap-2 pt-1 text-caption text-label-secondary">
                  <input
                    type="checkbox"
                    checked={s.agent}
                    disabled={!s.agent && s.cannotAgent !== undefined}
                    aria-label={t("settings.searchSources.agentLabel", { source: s.label })}
                    onChange={(e) => void configure({ source: s.id, agent: e.target.checked })}
                  />
                  {t("settings.searchSources.agent")}
                </label>
              ) : null}
              {s.enabled && !s.agent && s.cannotAgent !== undefined ? (
                <p className="text-caption text-label-secondary">
                  {t("settings.searchSources.cannotAgent", { why: s.cannotAgent })}
                </p>
              ) : null}
              {s.enabled && s.id === "files" ? (
                <label className="flex items-start gap-2 pt-1 text-caption text-label-secondary">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={s.ocr}
                    aria-label={t("settings.searchSources.ocrLabel", { source: s.label })}
                    onChange={(e) => void configure({ source: s.id, ocr: e.target.checked })}
                  />
                  <span className="flex flex-col">
                    {t("settings.searchSources.ocr")}
                    <span>{t("settings.searchSources.ocrHint")}</span>
                  </span>
                </label>
              ) : null}
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
              placeholder={t("settings.searchSources.excludeFoldersPlaceholder")}
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
