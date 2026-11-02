import type { GraphSource, GraphStatus } from "@psyche/protocol";
import { UserRound } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
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
import { formatTime } from "../../lib/format.ts";
import { RelationshipNudgesSettings, readNudgeSettings } from "../../nudges/NudgeSettings.tsx";
import { ConnectedEntityCard } from "../../people/ConnectedEntityCard.tsx";
import { usePersona, useSlots } from "../../slots.tsx";
import { MemoryAdvancedSection } from "./MemoryAdvancedSection.tsx";
import { MemoryPrivacySection } from "./MemoryPrivacySection.tsx";
import {
  GRAPH_DEFAULTS,
  GRAPH_SETTING,
  GRAPH_SOURCES,
  type GraphSettings,
  readGraphSettings,
} from "./PeopleGraphSettings.tsx";
import {
  ErrorNotice,
  Group,
  LoadGate,
  SectionFrame,
  SwitchField,
  useSettingsForm,
} from "./shared.tsx";

/**
 * Settings → Memory → People and projects (docs/memory/people-and-projects-2026.md §6.7, §7): which
 * sources cards are learned from, your own card, and keeping in touch. Everything stays on this
 * Mac and every source is off until the owner turns it on. The switch is in Basics; privacy and
 * the model and retention choices follow as their own sections.
 */

export { GRAPH_DEFAULTS, GRAPH_SETTING, type GraphSettings, readGraphSettings };

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
  /** Turns People and projects on (Basics has the same switch). */
  onTurnOn?: () => void;
  busy?: boolean;
  notice?: { kind: "ok" | "error"; text: string } | null;
  /** The "Keeping in touch" group (it brings its own heading). */
  nudges?: ReactNode;
}

/** Settings → Memory → People and projects: the sources cards are learned from, and your own card. */
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
  onTurnOn,
  notice = null,
  nudges,
}: PeoplePanelProps): ReactElement {
  const set = (patch: Partial<GraphSettings>) => onChange({ ...settings, ...patch });
  const sourceStatus = (s: GraphSource) => status?.sources.find((x) => x.source === s);
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
        {settings.enabled ? (
          <Group
            title={t("settings.people.sources")}
            description={t("settings.people.sourcesHint")}
          >
            {GRAPH_SOURCES.map((s) => {
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
                      : s === "messages"
                        ? t("settings.people.source.messagesHint")
                        : t("settings.people.sourceOff")
                  }
                  checked={on}
                  onChange={(v) => set({ sources: { ...settings.sources, [s]: v } })}
                />
              );
            })}
          </Group>
        ) : (
          <Group title={t("settings.people.graph")}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 flex-1 text-body text-label-secondary">
                {t("settings.people.off", { persona })}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!onTurnOn}
                onClick={onTurnOn}
              >
                {t("settings.people.turnOn")}
              </Button>
            </div>
          </Group>
        )}

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

        {nudges}
      </LoadGate>
    </SectionFrame>
  );
}

/**
 * Privacy and Advanced sit in the same pane as People and projects (the page lists four panes);
 * each is its own section with the pane separator above it.
 */
function Subsection({ children }: { children: ReactNode }): ReactElement {
  return <div className="mt-5 flex flex-col gap-5 border-t border-separator pt-8">{children}</div>;
}

/** Connected: the `memory.graph` setting, `memory.graph.status` and the owner's card. */
export function PeopleSection(): ReactElement {
  const form = useSettingsForm();
  const _call = useCall();
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
  const [busy, _setBusy] = useState(false);
  const [notice, _setNotice] = useState<PeoplePanelProps["notice"]>(null);

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
        onTurnOn={() =>
          form.onChange(GRAPH_SETTING, { ...readGraphSettings(form.values), enabled: true })
        }
        nudges={
          <RelationshipNudgesSettings
            {...readNudgeSettings(form.values)}
            onChange={form.onChange}
          />
        }
      />
      <Subsection>
        <MemoryPrivacySection />
      </Subsection>
      <Subsection>
        <MemoryAdvancedSection />
      </Subsection>
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
