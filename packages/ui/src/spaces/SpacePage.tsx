import type {
  SpaceDetail,
  SpaceTracker,
  SpaceTrackerTemplate,
  SpaceTrackerValue,
} from "@psyche/protocol";
import { ChevronLeft, Ellipsis, MessageSquarePlus, Plus, RefreshCw, X } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { useAutomations, useCall, useGoals, useStoreState } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { ScreenSection } from "../screens/feed/ScreenToolbar.tsx";
import { useSlots } from "../slots.tsx";
import { WidgetBlockView } from "../widgets/WidgetBlock.tsx";
import { ContextPreviewDialog, DeleteSpaceDialog, InstructionsDialog } from "./SpaceDialogs.tsx";
import { useSpace, useSpaceActions, useSpaceThreads } from "./use-spaces.ts";

const TEMPLATES: readonly SpaceTrackerTemplate[] = [
  "work_due",
  "next_events",
  "recent_files",
  "mail_on_this",
  "checklist",
  "automation_status",
];

/** The template names, as literal catalogue ids. */
const TEMPLATE_LABEL: Record<SpaceTrackerTemplate, () => string> = {
  work_due: () => t("spaces.template.work_due"),
  next_events: () => t("spaces.template.next_events"),
  recent_files: () => t("spaces.template.recent_files"),
  mail_on_this: () => t("spaces.template.mail_on_this"),
  checklist: () => t("spaces.template.checklist"),
  automation_status: () => t("spaces.template.automation_status"),
};

export interface SpacePageProps {
  spaceId: string;
  onNavigate?: (to: string) => void;
  now?: number;
}

/**
 * `/spaces/<id>` (docs/design/spaces-2026.md §7.1): off the sidebar like a goal's page, in Home's
 * one-column ruled sections. "New chat here" is the page's one accent. Opening the page calls
 * `spaces.open`, which recomputes stale query trackers without a model call.
 */
export function SpacePage({ spaceId, onNavigate, now: fixedNow }: SpacePageProps): ReactElement {
  const { navigate: slotNavigate } = useSlots();
  const navigate = onNavigate ?? slotNavigate ?? (() => {});
  const call = useCall();
  const actions = useSpaceActions();
  const now = useNow(60_000, fixedNow);
  const { detail, loading, error, reload } = useSpace(spaceId);
  const { chats, all: allThreads } = useSpaceThreads(spaceId);
  const [values, setValues] = useState<Record<string, SpaceTrackerValue>>({});
  const [dialog, setDialog] = useState<"instructions" | "preview" | "delete" | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: opens once per Space, not per reload
  useEffect(() => {
    let live = true;
    call("spaces.open", { spaceId }).then(
      (r) => {
        if (!live) return;
        setValues(Object.fromEntries(r.trackers.map((v) => [v.widgetId, v])));
        reload();
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [spaceId]);

  const fail = (err: unknown) => toast.error(describeError(err));
  const write = (p: Promise<unknown>) => p.then(reload, fail);

  if (detail === null) {
    return (
      <div className="mx-auto w-full max-w-[calc(720px+3rem)] px-4 pt-6 md:px-6">
        {loading ? (
          <Skeleton className="h-8 w-1/2" />
        ) : (
          <p role="status" className="text-body text-label-secondary">
            {error ? t("spaces.page.loadFailed", { reason: error }) : t("spaces.page.notFound")}
          </p>
        )}
        <BackLink onNavigate={navigate} />
      </div>
    );
  }
  const { space } = detail;
  const archived = space.archivedAt != null;
  const startChat = () => actions.newChatIn(space.id).then((id) => navigate(`/chat/${id}`), fail);

  return (
    <div className="@container/home flex min-h-0 flex-1 flex-col" data-testid="space-page">
      <div className="mx-auto flex w-full max-w-[calc(720px+3rem)] flex-col gap-8 px-4 pt-4 pb-16 md:px-6">
        <header className="flex flex-col gap-2">
          <BackLink onNavigate={navigate} />
          <div className="flex items-start gap-3">
            <h1 className="min-w-0 flex-1 font-display text-page-title text-label-primary">
              {space.name}
            </h1>
            <Button type="button" onClick={() => void startChat()} disabled={archived}>
              <MessageSquarePlus aria-hidden="true" />
              {t("spaces.page.newChat")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t("spaces.page.more")}
                  />
                }
              >
                <Ellipsis aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setDialog("instructions")}>
                  {t("spaces.menu.instructions")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDialog("preview")}>
                  {t("spaces.menu.preview")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    void write(call("spaces.update", { spaceId, private: !space.private }))
                  }
                >
                  {space.private ? t("spaces.menu.showOnHome") : t("spaces.menu.keepPrivate")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() =>
                    void write(call(archived ? "spaces.restore" : "spaces.archive", { spaceId }))
                  }
                >
                  {archived ? t("spaces.menu.restore") : t("spaces.menu.archive")}
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => setDialog("delete")}>
                  {t("spaces.menu.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {space.description ? (
            <p className="text-body text-label-secondary">{space.description}</p>
          ) : null}
          <p className="flex flex-wrap gap-x-2 text-callout text-label-secondary">
            <button
              type="button"
              className="cursor-default underline-offset-2 hover:underline"
              onClick={() => setDialog("instructions")}
            >
              {t("spaces.summary.instructions")}
            </button>
            <span aria-hidden="true">·</span>
            <span>{t("spaces.summary.folders", { n: detail.folders.length })}</span>
            <span aria-hidden="true">·</span>
            <span>{t("spaces.summary.links", { n: detail.links.length })}</span>
            {space.private ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{t("spaces.private")}</span>
              </>
            ) : null}
          </p>
          {archived ? (
            <p role="status" className="text-callout text-label-secondary">
              {t("spaces.page.archivedNote")}
            </p>
          ) : null}
        </header>

        <div className="flex flex-col [&>*+*]:mt-8 [&>*+*]:border-t [&>*+*]:border-separator [&>*+*]:pt-8">
          <TrackersSection
            detail={detail}
            values={values}
            now={now}
            onChange={() => reload()}
            onRefreshed={(v) => setValues((prev) => ({ ...prev, [v.widgetId]: v }))}
          />
          <ScreenSection
            id="chats"
            title={t("spaces.chats")}
            actions={
              <MoveChatIn
                spaceId={spaceId}
                candidates={allThreads.filter(
                  (e) =>
                    e.thread.spaceId !== spaceId &&
                    e.thread.kind === "side" &&
                    e.thread.archivedAt == null,
                )}
                onMove={(id) => write(actions.moveThreads([id], spaceId))}
              />
            }
          >
            {chats.length === 0 ? (
              <Quiet>{t("spaces.chats.empty")}</Quiet>
            ) : (
              <ul className="flex flex-col">
                {chats.map((e) => (
                  <li key={e.thread.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={t("spaces.chats.open", { title: e.thread.title })}
                      onClick={() => navigate(`/chat/${e.thread.id}`)}
                      className="flex min-h-9 min-w-0 flex-1 cursor-default items-baseline justify-between gap-3 rounded-md px-2.5 text-start outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="truncate text-body text-label-primary">
                        {e.thread.title}
                      </span>
                      <span className="shrink-0 text-callout text-label-secondary">
                        {formatRelative(e.thread.lastMessageAt ?? e.thread.updatedAt, now)}
                      </span>
                    </button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t("spaces.chats.moveOut", { title: e.thread.title })}
                      onClick={() => void write(actions.moveThreads([e.thread.id], null))}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </ScreenSection>
          <AutomationsSection ids={detail.automationIds} />
          <ScreenSection id="files" title={t("spaces.files")}>
            {detail.folders.length === 0 && detail.links.length === 0 ? (
              <Quiet>{t("spaces.files.empty")}</Quiet>
            ) : (
              <ul className="flex flex-col">
                {detail.folders.map((f) => (
                  <li
                    key={f.path}
                    className="flex min-h-9 items-baseline justify-between gap-3 px-2.5"
                  >
                    <span className="truncate font-mono text-callout text-label-primary">
                      {f.path}
                    </span>
                    <span className="shrink-0 text-callout text-label-secondary">
                      {f.mode === "rw" ? t("spaces.files.rw") : t("spaces.files.ro")}
                      {f.mode === "rw" && !f.automationsWrite
                        ? ` · ${t("spaces.files.automationsRo")}`
                        : ""}
                    </span>
                  </li>
                ))}
                {detail.links.map((l) => (
                  <li
                    key={l.id}
                    className="flex min-h-9 items-baseline justify-between gap-3 px-2.5"
                  >
                    <span className="truncate text-body text-label-primary">{l.label}</span>
                    <span className="min-w-0 shrink truncate text-callout text-label-secondary">
                      {l.ref}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Quiet>{t("spaces.files.addOnMac")}</Quiet>
          </ScreenSection>
          <GoalsSection ids={detail.goalIds} onNavigate={navigate} />
        </div>
      </div>
      <InstructionsDialog
        open={dialog === "instructions"}
        onOpenChange={(o) => setDialog(o ? "instructions" : null)}
        spaceId={spaceId}
        name={space.name}
        initial={space.instructions}
        onSaved={reload}
      />
      <ContextPreviewDialog
        open={dialog === "preview"}
        onOpenChange={(o) => setDialog(o ? "preview" : null)}
        spaceId={spaceId}
      />
      <DeleteSpaceDialog
        open={dialog === "delete"}
        onOpenChange={(o) => setDialog(o ? "delete" : null)}
        name={space.name}
        onConfirm={() => {
          setDialog(null);
          call("spaces.delete", { spaceId }).then(() => navigate("/spaces"), fail);
        }}
      />
    </div>
  );
}

function BackLink({ onNavigate }: { onNavigate: (to: string) => void }): ReactElement {
  return (
    <nav aria-label={t("spaces.page.home")}>
      <button
        type="button"
        onClick={() => onNavigate("/home")}
        className="inline-flex cursor-default items-center gap-1 rounded-sm text-callout text-label-secondary outline-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronLeft className="size-3.5 rtl:rotate-180" aria-hidden="true" />
        {t("spaces.page.home")}
        <span aria-hidden="true">›</span>
        {t("spaces.title")}
      </button>
    </nav>
  );
}

const Quiet = ({ children }: { children: ReactNode }): ReactElement => (
  <p className="px-2.5 text-callout text-label-secondary">{children}</p>
);

function TrackersSection({
  detail,
  values,
  now,
  onChange,
  onRefreshed,
}: {
  detail: SpaceDetail;
  values: Record<string, SpaceTrackerValue>;
  now: number;
  onChange: () => void;
  onRefreshed: (v: SpaceTrackerValue) => void;
}): ReactElement {
  const call = useCall();
  const spaceId = detail.space.id;
  const fail = (err: unknown) => toast.error(describeError(err));
  return (
    <ScreenSection
      id="trackers"
      title={t("spaces.trackers")}
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={t("spaces.trackers.addLabel")}
              />
            }
          >
            <Plus aria-hidden="true" />
            {t("spaces.trackers.add")}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {TEMPLATES.map((template) => (
              <DropdownMenuItem
                key={template}
                onClick={() =>
                  void call("spaces.trackers.add", { spaceId, template }).then(onChange, fail)
                }
              >
                {TEMPLATE_LABEL[template]()}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {detail.trackers.length === 0 ? (
        <Quiet>{t("spaces.trackers.empty")}</Quiet>
      ) : (
        <ul className="grid grid-cols-1 gap-x-4 @2xl/home:grid-cols-2">
          {[...detail.trackers]
            .sort((a, b) => a.position - b.position)
            .map((tracker) => (
              <li key={tracker.widgetId} className="min-w-0">
                <TrackerCard
                  tracker={tracker}
                  value={values[tracker.widgetId]}
                  now={now}
                  onRemove={() =>
                    void call("spaces.trackers.remove", {
                      spaceId,
                      widgetId: tracker.widgetId,
                    }).then(onChange, fail)
                  }
                  onRefresh={() =>
                    void call("spaces.trackers.refresh", {
                      spaceId,
                      widgetId: tracker.widgetId,
                    }).then((r) => {
                      onRefreshed(r.tracker);
                      onChange();
                    }, fail)
                  }
                />
              </li>
            ))}
        </ul>
      )}
    </ScreenSection>
  );
}

/** A tracker: the host-drawn widget frame, then when it was updated, from where, and Refresh. */
function TrackerCard({
  tracker,
  value,
  now,
  onRefresh,
  onRemove,
}: {
  tracker: SpaceTracker;
  value: SpaceTrackerValue | undefined;
  now: number;
  onRefresh: () => void;
  onRemove: () => void;
}): ReactElement {
  const title =
    useStoreState((st) => st.widgets[tracker.widgetId]?.spec.title) ?? t("spaces.trackers");
  const refreshedAt = value?.refreshedAt ?? tracker.refreshedAt;
  const refreshable = tracker.kind !== "bound";
  return (
    <div data-testid="tracker" data-widget-id={tracker.widgetId}>
      <WidgetBlockView block={{ type: "ui", widgetId: tracker.widgetId }} surface="overview" />
      <div className="-mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-callout text-label-secondary">
        <span>
          {refreshedAt == null
            ? t("spaces.tracker.neverUpdated")
            : t("spaces.tracker.updated", { when: formatRelative(refreshedAt, now) })}
          {value?.source ? ` · ${t("spaces.tracker.source", { source: value.source })}` : ""}
        </span>
        {tracker.addedBy === "agent" ? <span>{t("spaces.tracker.addedByPsyche")}</span> : null}
        {value?.unavailable ? <span>{t("spaces.tracker.unavailable")}</span> : null}
        <span className="ms-auto flex items-center gap-1">
          {refreshable ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-label={t("spaces.tracker.refreshLabel", { title: title })}
              onClick={onRefresh}
            >
              <RefreshCw aria-hidden="true" />
              {t("spaces.tracker.refresh")}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={t("spaces.tracker.remove", { title: title })}
            onClick={onRemove}
          >
            <X aria-hidden="true" />
          </Button>
        </span>
      </div>
    </div>
  );
}

function AutomationsSection({ ids }: { ids: readonly string[] }): ReactElement {
  const { automations } = useAutomations();
  const mine = automations.filter((a) => ids.includes(a.id));
  return (
    <ScreenSection id="automations" title={t("spaces.automations")}>
      {mine.length === 0 ? (
        <Quiet>{t("spaces.automations.empty")}</Quiet>
      ) : (
        <ul className="flex flex-col">
          {mine.map((a) => (
            <li key={a.id} className="flex min-h-9 items-baseline gap-3 px-2.5">
              <span className="min-w-0 flex-1 truncate text-body text-label-primary">
                {a.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </ScreenSection>
  );
}

function GoalsSection({
  ids,
  onNavigate,
}: {
  ids: readonly string[];
  onNavigate: (to: string) => void;
}): ReactElement | null {
  const { goals } = useGoals();
  const mine = goals.filter((g) => ids.includes(g.id));
  if (mine.length === 0) return null;
  return (
    <ScreenSection id="goals" title={t("spaces.goals")}>
      <ul className="flex flex-col">
        {mine.map((g) => (
          <li key={g.id}>
            <button
              type="button"
              onClick={() => onNavigate(`/goals/${g.id}`)}
              className="flex min-h-9 w-full cursor-default items-center rounded-md px-2.5 text-start text-body text-label-primary outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
            >
              {g.title}
            </button>
          </li>
        ))}
      </ul>
    </ScreenSection>
  );
}

/** "Move a chat in": the owner's other side chats, one tap each. */
function MoveChatIn({
  candidates,
  onMove,
}: {
  spaceId: string;
  candidates: readonly { thread: { id: string; title: string } }[];
  onMove: (threadId: string) => void;
}): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" size="sm" variant="ghost" />}>
        {t("spaces.chats.moveIn")}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
        {candidates.length === 0 ? (
          <DropdownMenuItem disabled>{t("spaces.chats.moveNone")}</DropdownMenuItem>
        ) : (
          candidates.map((e) => (
            <DropdownMenuItem key={e.thread.id} onClick={() => onMove(e.thread.id)}>
              {e.thread.title}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
