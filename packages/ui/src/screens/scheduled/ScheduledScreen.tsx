import type { DailyAutomationDraft, ScheduledItem } from "@psyche/protocol";
import { CalendarClock, Plus } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { toast } from "sonner";
import { usePrefillComposer } from "../../chat/prefill.ts";
import {
  EmptyState,
  ErrorState,
  LoadingCards,
  Page,
  PageHeader,
  SectionLabel,
  useDelayedFlag,
} from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/index.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { useNow } from "../../lib/use-now.ts";
import { itemName } from "./format.ts";
import { RunHistory } from "./RunHistory.tsx";
import { ScheduledRow, type ScheduledRowProps } from "./ScheduledRow.tsx";

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
    | "onParseEdit"
    | "onSaveEdit"
    | "onEditInChat"
    | "renderHistory"
  > {
  items: readonly ScheduledItem[];
  timezone: string;
  now: number;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Opens a chat with the task → automation flow started; `text` is an example, if one was picked. */
  onNewAutomation: (text?: string) => void;
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
  ...rowProps
}: ScheduledViewProps): ReactElement {
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
    <Page width="prose">
      <PageHeader
        title={t("scheduled.title")}
        description={t("scheduled.description")}
        meta={t("scheduled.timezone", { zone: timezone })}
        actions={
          <Button type="button" onClick={() => onNewAutomation()}>
            <Plus aria-hidden="true" />
            {t("scheduled.new")}
          </Button>
        }
      />
      {error && items.length === 0 ? (
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
                <EmptyState
                  icon={CalendarClock}
                  className="pt-6 pb-2"
                  action={{ label: t("scheduled.new"), onClick: () => onNewAutomation() }}
                >
                  {t("scheduled.empty.title")}
                  <span className="mt-2 block text-callout">{t("scheduled.empty.hint")}</span>
                </EmptyState>
                <ul aria-label={t("scheduled.empty.hint")} className="flex flex-col items-center">
                  {EXAMPLES.map((id) => (
                    <li key={id}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
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
    </Page>
  );
}

export interface ScheduledScreenProps {
  /** Opens a route: a chat, a run's transcript, a Settings section. */
  onNavigate?: (route: string) => void;
  /** A fixed clock for stories and tests. */
  now?: number;
}

/** `/scheduled`, wired to the Gateway. */
export function ScheduledScreen({ onNavigate, now: fixedNow }: ScheduledScreenProps): ReactElement {
  const call = useCall();
  const q = useGatewayQuery("scheduled.list", {});
  const prefill = usePrefillComposer();
  const now = useNow(30_000, fixedNow);
  const timezone = q.data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

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

  return (
    <ScheduledView
      items={q.data?.items ?? []}
      timezone={timezone}
      now={now}
      loading={q.loading}
      error={q.error}
      onRetry={q.reload}
      onNewAutomation={(text) => toChat(text ?? t("scheduled.new.prefill"))}
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
      onParseEdit={(_item, text) => call("daily.automations.parse", { text })}
      onSaveEdit={async (item, draft: DailyAutomationDraft) => {
        await call("automations.update", {
          automationId: item.id,
          title: draft.title,
          schedule: draft.schedule,
          timezone: draft.timezone,
          prompt: draft.prompt,
        });
        toast.success(t("scheduled.toast.saved", { title: draft.title }));
        q.reload();
      }}
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
