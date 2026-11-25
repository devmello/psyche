import type { Automation, ScheduledItem, ThreadListEntry } from "@psyche/protocol";
import { CalendarClock, Plus } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { usePrefillComposer } from "../../chat/prefill.ts";
import {
  EmptyState,
  ErrorState,
  LoadingCards,
  SectionLabel,
  useDelayedFlag,
} from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx";
import { useCall, useGatewayQuery } from "../../data/index.ts";
import { collectAllPages } from "../../data/list-pages.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { useNow } from "../../lib/use-now.ts";
import { ScreenColumn, ScreenToolbar, ToolbarLabel } from "../feed/ScreenToolbar.tsx";
import { AutomationForm } from "./AutomationForm.tsx";
import { itemName } from "./format.ts";
import { RunHistory } from "./RunHistory.tsx";
import { ScheduledRow, type ScheduledRowProps } from "./ScheduledRow.tsx";
import { ScheduledRuns } from "./ScheduledRuns.tsx";
import { type AutomationFormValues, saveAutomation, systemZone } from "./schedule-form.ts";

const EXAMPLES = [
  "scheduled.empty.example.1",
  "scheduled.empty.example.2",
  "scheduled.empty.example.3",
] as const;

export interface ScheduledViewProps
  extends Pick<
    ScheduledRowProps,
    | "onPause"
    | "onRunNow"
    | "onDelete"
    | "onOpenSettings"
    | "onEdit"
    | "onEditInChat"
    | "renderHistory"
  > {
  items: readonly ScheduledItem[];
  timezone: string;
  now: number;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Opens the automation form; `text` is an example's instructions, if one was picked. */
  onNewAutomation: (text?: string) => void;
  /** The Runs tab's content; without it the screen has no tabs. */
  runsPanel?: ReactNode;
  /** The tab to open on. */
  initialTab?: "schedule" | "runs";
}

/** The Scheduled screen: your automations, then Psyche's routines. */
export function ScheduledView({
  items,
  timezone,
  now,
  loading = false,
  error = null,
  onRetry,
  onNewAutomation,
  runsPanel,
  initialTab = "schedule",
  ...rowProps
}: ScheduledViewProps): ReactElement {
  const [tab, setTab] = useState<"schedule" | "runs">(initialTab);
  const showSkeleton = useDelayedFlag(loading && items.length === 0);
  const owner = items.filter((i) => i.group === "owner");
  const routines = items.filter((i) => i.group === "routine");
  const row = (item: ScheduledItem): ReactElement => (
    <ScheduledRow key={item.id} item={item} now={now} timezone={timezone} {...rowProps} />
  );
  const section = (id: string, label: string, hint: string | null, children: ReactNode) => (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <SectionLabel id={id}>{label}</SectionLabel>
        {hint ? <p className="text-callout text-label-secondary">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
  return (
    <>
      <ScreenToolbar
        title={t("scheduled.title")}
        meta={t("scheduled.timezone", { zone: timezone })}
        actions={
          <Button
            type="button"
            size="sm"
            title={t("scheduled.new")}
            onClick={() => onNewAutomation()}
          >
            <Plus aria-hidden="true" />
            <ToolbarLabel>{t("scheduled.new")}</ToolbarLabel>
          </Button>
        }
      />
      <ScreenColumn width="wide" className="gap-6">
        <p className="text-body text-label-secondary">{t("scheduled.description")}</p>
        {runsPanel !== undefined ? (
          <Tabs value={tab} onValueChange={(v) => setTab(v as "schedule" | "runs")}>
            <TabsList>
              <TabsTrigger value="schedule">{t("scheduled.tab.schedule")}</TabsTrigger>
              <TabsTrigger value="runs">{t("scheduled.tab.runs")}</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}
        {tab === "runs" && runsPanel !== undefined ? (
          runsPanel
        ) : error && items.length === 0 ? (
          <ErrorState
            what={t("scheduled.loadFailed")}
            reason={error}
            {...(onRetry ? { retry: { onClick: onRetry } } : {})}
          />
        ) : loading && items.length === 0 ? (
          showSkeleton ? (
            <LoadingCards label={t("scheduled.loading")} count={3} lines={3} />
          ) : null
        ) : (
          <>
            {section(
              "scheduled-owner",
              `${t("scheduled.group.owner")}${owner.length > 0 ? ` (${owner.length})` : ""}`,
              null,
              owner.length === 0 ? (
                <>
                  <EmptyState icon={CalendarClock} className="pt-6 pb-2">
                    {t("scheduled.empty.title")}
                    <span className="mt-2 block text-callout">{t("scheduled.empty.hint")}</span>
                  </EmptyState>
                  <ul
                    aria-label={t("scheduled.empty.hint")}
                    className="flex flex-wrap justify-center gap-2 px-6"
                  >
                    {EXAMPLES.map((id) => (
                      <li key={id}>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-auto min-h-7 whitespace-normal py-1 text-start font-normal text-label-secondary"
                          aria-label={t("scheduled.empty.example.aria", { text: t(id) })}
                          onClick={() => onNewAutomation(t(id))}
                        >
                          {t(id)}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <ul className="flex flex-col gap-3">{owner.map(row)}</ul>
              ),
            )}
            {section(
              "scheduled-routines",
              `${t("scheduled.group.routine")}${routines.length > 0 ? ` (${routines.length})` : ""}`,
              t("scheduled.group.routine.hint"),
              routines.length === 0 ? (
                <p className="text-callout text-label-secondary">{t("scheduled.routines.empty")}</p>
              ) : (
                <ul className="flex flex-col gap-3">{routines.map(row)}</ul>
              ),
            )}
          </>
        )}
      </ScreenColumn>
    </>
  );
}

export interface ScheduledScreenProps {
  /** Opens a route: a chat, a run's transcript, a Settings section. */
  onNavigate?: (route: string) => void;
  /** A fixed clock for stories and tests. */
  now?: number;
  /** `/scheduled?tab=runs` opens on the Runs tab (a run's notification lands there). */
  initialTab?: "schedule" | "runs";
}

/** `/scheduled`, wired to the Gateway. */
export function ScheduledScreen({
  onNavigate,
  now: fixedNow,
  initialTab,
}: ScheduledScreenProps): ReactElement {
  const call = useCall();
  const q = useGatewayQuery("scheduled.list", {});
  // Every chat for the picker, across all pages of `threads.list` (the Gateway caps a page at 50).
  const [chats, setChats] = useState<ThreadListEntry[]>([]);
  useEffect(() => {
    let live = true;
    collectAllPages(async (cursor) => {
      const r = await call("threads.list", cursor === undefined ? {} : { cursor });
      return { items: r.threads, nextCursor: r.nextCursor };
    }, 10).then(
      (all) => {
        if (live) setChats(all);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [call]);
  const prefill = usePrefillComposer();
  const now = useNow(30_000, fixedNow);
  const timezone = q.data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The automation form replaces the list while it is open: a new one, or an edit.
  const [editor, setEditor] = useState<{ automation?: Automation; prompt?: string } | null>(null);

  const fail = (err: unknown) =>
    toast.error(`${t("scheduled.toast.failed")} ${describeError(err)}`);
  const toChat = (text: string) => {
    if (prefill) prefill(text);
    else onNavigate?.("/chat");
  };
  const act = (done: string, run: Promise<unknown>) =>
    run
      .then(() => {
        toast.success(done);
        q.reload();
      })
      .catch(fail);
  // The owner's own automation in full (its delivery is not on the Scheduled list).
  const openEdit = async (item: ScheduledItem) => {
    try {
      const { automations } = await call("automations.list", {});
      const automation = automations.find((a) => a.id === item.id);
      if (automation === undefined) return toast.error(t("scheduled.form.notFound"));
      setEditor({ automation });
    } catch (err) {
      fail(err);
    }
  };
  const save = async (values: AutomationFormValues, editing?: Automation) => {
    const zone = editing?.timezone ?? systemZone();
    await saveAutomation(
      call,
      values,
      { zone, now: Date.now(), ...(editing ? { editing } : {}) },
      editing,
    );
    toast.success(
      editing
        ? t("scheduled.toast.saved", { title: values.title.trim() || editing.title })
        : t("scheduled.form.toast.created", {
            title: values.title.trim() || values.prompt.trim().slice(0, 60),
          }),
    );
    setEditor(null);
    q.reload();
  };

  if (editor !== null) {
    const { automation } = editor;
    return (
      <AutomationForm
        {...(automation ? { automation } : {})}
        {...(editor.prompt ? { initialPrompt: editor.prompt } : {})}
        now={now}
        threads={chats.map((e) => ({
          id: e.thread.id,
          title: e.thread.title,
        }))}
        onSave={(values) => save(values, automation)}
        {...(automation
          ? {
              onDelete: () =>
                call("automations.delete", { automationId: automation.id }).then(() => {
                  toast.success(t("scheduled.toast.deleted", { title: itemName(automation) }));
                  setEditor(null);
                  q.reload();
                }),
            }
          : {})}
        onCancel={() => setEditor(null)}
      />
    );
  }

  return (
    <ScheduledView
      {...(initialTab ? { initialTab } : {})}
      items={q.data?.items ?? []}
      timezone={timezone}
      now={now}
      loading={q.loading}
      error={q.error}
      onRetry={q.reload}
      runsPanel={
        <ScheduledRuns now={now} timezone={timezone} {...(onNavigate ? { onNavigate } : {})} />
      }
      onNewAutomation={(text) => setEditor({ ...(text ? { prompt: text } : {}) })}
      onEdit={(item) => void openEdit(item)}
      onPause={(item, paused) =>
        void act(
          t(paused ? "scheduled.toast.paused" : "scheduled.toast.resumed", {
            title: itemName(item),
          }),
          call("scheduled.pause", { id: item.id, paused }),
        )
      }
      onRunNow={(item) =>
        void act(
          t("scheduled.toast.started", { title: itemName(item) }),
          call("automations.run", { automationId: item.id }),
        )
      }
      onDelete={(item) =>
        void act(
          t("scheduled.toast.deleted", { title: itemName(item) }),
          call("automations.delete", { automationId: item.id }),
        )
      }
      onEditInChat={(item) => toChat(t("scheduled.edit.prefill", { title: itemName(item) }))}
      {...(onNavigate
        ? { onOpenSettings: (section: string) => onNavigate(`/settings/${section}`) }
        : {})}
      renderHistory={(item) => (
        <RunHistory
          automationId={item.id}
          now={now}
          timezone={timezone}
          {...(onNavigate ? { onNavigate } : {})}
        />
      )}
    />
  );
}
