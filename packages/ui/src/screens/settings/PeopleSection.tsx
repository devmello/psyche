import type { GraphSource, GraphStatus } from "@psyche/protocol";
import { Download, UserRound } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { formatTime } from "../../lib/format.ts";
import { ConnectedEntityCard } from "../../people/ConnectedEntityCard.tsx";
import { usePersona, useSlots } from "../../slots.tsx";
import type { ExportFile } from "./DataControlsSection.tsx";
import {
  ErrorNotice,
  Group,
  LoadGate,
  RadioField,
  SectionFrame,
  SwitchField,
  useSettingsForm,
} from "./shared.tsx";

/**
 * Settings → Privacy → People & projects (docs/memory/people-and-projects-2026.md §6.7, §7): the
 * graph on or off, sources one by one with what each produced, how long interactions are kept,
 * names in replies, the nightly learning pass and its budget, "What Psyche knows about me" and
 * export. Everything stays on this Mac; every source is off until the owner turns it on.
 */

export const GRAPH_SETTING = "memory.graph";

export interface GraphSettings {
  enabled: boolean;
  sources: Record<GraphSource, boolean>;
  interactionRetentionDays: number;
  entityRecall: boolean;
  model: {
    nightly: boolean;
    afterRun: boolean;
    maxEntitiesPerNight: number;
    maxTokensPerNight: number;
  };
}

const SOURCES: readonly GraphSource[] = [
  "contacts",
  "mail",
  "calendar",
  "messages",
  "notes",
  "chats",
];

/** The spec's defaults (§4.7): off, sources off except chats (the owner's own words). */
export const GRAPH_DEFAULTS: GraphSettings = {
  enabled: false,
  sources: {
    contacts: false,
    mail: false,
    calendar: false,
    messages: false,
    notes: false,
    chats: true,
  },
  interactionRetentionDays: 540,
  entityRecall: true,
  model: { nightly: true, afterRun: true, maxEntitiesPerNight: 200, maxTokensPerNight: 150000 },
};

/** The stored object merged over the defaults, so a partial value never drops a field. */
export function readGraphSettings(values: Readonly<Record<string, unknown>>): GraphSettings {
  const raw = values[GRAPH_SETTING];
  const v = (raw && typeof raw === "object" ? raw : {}) as Partial<GraphSettings>;
  return {
    ...GRAPH_DEFAULTS,
    ...v,
    sources: { ...GRAPH_DEFAULTS.sources, ...(v.sources ?? {}) },
    model: { ...GRAPH_DEFAULTS.model, ...(v.model ?? {}) },
  };
}

const RETENTION_DAYS = ["180", "365", "540", "730"] as const;

export interface PeoplePanelProps {
  settings: GraphSettings;
  onChange: (next: GraphSettings) => void;
  status?: GraphStatus | null;
  persona: string;
  needsApproval?: ReadonlySet<string>;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onOpenOwnCard?: () => void;
  onExport?: () => void;
  busy?: boolean;
  notice?: { kind: "ok" | "error"; text: string } | null;
}

export function PeoplePanel({
  settings,
  onChange,
  status = null,
  persona,
  needsApproval,
  loading = false,
  error = null,
  onRetry,
  onOpenOwnCard,
  onExport,
  busy = false,
  notice = null,
}: PeoplePanelProps): ReactElement {
  const set = (patch: Partial<GraphSettings>) => onChange({ ...settings, ...patch });
  const sourceStatus = (s: GraphSource) => status?.sources.find((x) => x.source === s);
  const off = !settings.enabled;
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title={t("settings.people.title")}
      description={t("settings.people.description", { persona })}
    >
      <LoadGate
        label={t("settings.people.loadLabel")}
        loading={loading}
        error={error}
        {...(onRetry ? { onRetry } : {})}
      >
        {notice ? (
          notice.kind === "error" ? (
            <ErrorNotice what={notice.text} did="" />
          ) : (
            <p role="status" className="rounded-md bg-fill-tertiary px-3 py-2 text-callout">
              {notice.text}
            </p>
          )
        ) : null}
        <Group title={t("settings.people.graph")}>
          <SwitchField
            label={t("settings.people.enabled")}
            description={t("settings.people.enabledHint", { persona })}
            checked={settings.enabled}
            settingKey={GRAPH_SETTING}
            onChange={(enabled) => set({ enabled })}
          />
          <SwitchField
            label={t("settings.people.entityRecall")}
            description={t("settings.people.entityRecallHint", { persona })}
            checked={settings.entityRecall}
            disabled={off}
            onChange={(entityRecall) => set({ entityRecall })}
          />
        </Group>

        <Group title={t("settings.people.sources")} description={t("settings.people.sourcesHint")}>
          {SOURCES.map((s) => {
            const st = sourceStatus(s);
            const on = settings.sources[s];
            return (
              <SwitchField
                key={s}
                label={t(`settings.people.source.${s}`)}
                description={
                  on && st
                    ? t("settings.people.sourceCounts", {
                        entities: st.entities,
                        interactions: st.interactions,
                        read: st.lastIngestAt ? formatTime(st.lastIngestAt) : "none",
                      })
                    : t("settings.people.sourceOff")
                }
                checked={on}
                disabled={off}
                onChange={(v) => set({ sources: { ...settings.sources, [s]: v } })}
              />
            );
          })}
        </Group>

        <Group title={t("settings.people.retention")}>
          <RadioField
            label={t("settings.people.retentionLabel")}
            description={t("settings.people.retentionHint")}
            inline
            value={
              RETENTION_DAYS.find((d) => Number(d) === settings.interactionRetentionDays) ?? "540"
            }
            onChange={(v) => set({ interactionRetentionDays: Number(v) })}
            options={RETENTION_DAYS.map((d) => ({
              value: d,
              label: t("settings.people.months", { n: Math.round(Number(d) / 30) }),
            }))}
          />
        </Group>

        <Group
          title={t("settings.people.learning")}
          description={
            status
              ? t("settings.people.budget", {
                  tokens: status.budget.tokensUsed,
                  maxTokens: status.budget.maxTokens,
                  entities: status.budget.entitiesUsed,
                  maxEntities: status.budget.maxEntities,
                })
              : t("settings.people.learningHint")
          }
        >
          <SwitchField
            label={t("settings.people.nightly")}
            description={t("settings.people.nightlyHint")}
            checked={settings.model.nightly}
            disabled={off}
            onChange={(nightly) => set({ model: { ...settings.model, nightly } })}
          />
          <SwitchField
            label={t("settings.people.afterRun")}
            description={t("settings.people.afterRunHint")}
            checked={settings.model.afterRun}
            disabled={off}
            onChange={(afterRun) => set({ model: { ...settings.model, afterRun } })}
          />
          {status && status.loopPrecision.length > 0 ? (
            <p className="text-callout text-label-secondary">
              {t("settings.people.precision", {
                list: status.loopPrecision
                  .map((p) =>
                    t("settings.people.precisionItem", {
                      source: t(`settings.people.source.${p.source}`),
                      confirmed: p.confirmed,
                      total: p.confirmed + p.dismissed,
                    }),
                  )
                  .join(", "),
              })}
            </p>
          ) : null}
        </Group>

        <Group
          title={t("settings.people.aboutYou")}
          description={t("settings.people.aboutYouHint", { persona })}
        >
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!onOpenOwnCard}
              onClick={onOpenOwnCard}
            >
              <UserRound aria-hidden="true" /> {t("settings.people.openOwnCard")}
            </Button>
          </div>
        </Group>

        <Group title={t("settings.people.export")} description={t("settings.people.exportHint")}>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!onExport || busy}
              onClick={onExport}
            >
              <Download aria-hidden="true" /> {t("settings.people.exportButton")}
            </Button>
          </div>
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

export interface PeopleSectionProps {
  /** Receives the export zip (it includes graph.json and the card files). */
  onExportReady?: (file: ExportFile) => void;
}

/** Connected: the `memory.graph` setting, `memory.graph.status`, the owner's card and export. */
export function PeopleSection({ onExportReady }: PeopleSectionProps): ReactElement {
  const form = useSettingsForm();
  const call = useCall();
  const persona = usePersona();
  const { navigate } = useSlots();
  const status = useGatewayQuery("memory.graph.status", {});
  const people = useGatewayQuery("memory.entities.search", {
    q: "",
    kinds: ["person"],
    limit: 100,
  });
  const owner = people.data?.entities.find((e) => e.isOwner) ?? null;
  const [ownOpen, setOwnOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<PeoplePanelProps["notice"]>(null);

  return (
    <>
      <PeoplePanel
        settings={readGraphSettings(form.values)}
        onChange={(next) => form.onChange(GRAPH_SETTING, next)}
        status={status.data ?? null}
        persona={persona.name}
        needsApproval={form.needsApproval}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
        busy={busy}
        notice={notice ?? (form.writeError ? { kind: "error", text: form.writeError } : null)}
        {...(owner ? { onOpenOwnCard: () => setOwnOpen(true) } : {})}
        onExport={() => {
          setBusy(true);
          setNotice(null);
          call("memory.export", {})
            .then((file) => {
              onExportReady?.(file);
              setNotice({
                kind: "ok",
                text: t("settings.data.exportReady", { filename: file.filename }),
              });
            })
            .catch((err: unknown) =>
              setNotice({
                kind: "error",
                text: t("people.writeFailed", { reason: describeError(err) }),
              }),
            )
            .finally(() => setBusy(false));
        }}
      />
      <Dialog open={ownOpen} onOpenChange={setOwnOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("settings.people.aboutYou")}</DialogTitle>
            <DialogDescription>{t("settings.people.ownCardHint")}</DialogDescription>
          </DialogHeader>
          {owner ? (
            <ConnectedEntityCard
              id={owner.id}
              className="bg-transparent p-0 shadow-none"
              onOpenEntity={(id) => {
                setOwnOpen(false);
                navigate?.(`/agent/soul?entity=${encodeURIComponent(id)}`);
              }}
            />
          ) : null}
          <div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setOwnOpen(false);
                navigate?.("/agent/soul?file=USER.md");
              }}
            >
              {t("settings.people.editUserMd")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
