import { CalendarClock, Fingerprint, ListChecks, ShieldCheck, X } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect } from "react";
import { Avatar } from "../avatar/Avatar.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { usePersona } from "../slots.tsx";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { ApprovalsPanel, useApprovalQueue } from "./ApprovalsPanel.tsx";
import { SoulMemoryPanel } from "./SoulMemoryPanel.tsx";
import { UpcomingPanel } from "./UpcomingPanel.tsx";
import { useAgentStatus } from "./useAgentState.ts";

export type AgentTab = "activity" | "approvals" | "upcoming" | "soul";

/**
 * The sheet's header (redesign §5.7, docs/06 §4.7): the 64 px avatar (which carries the state),
 * the persona's name in text-title-2 and the state with the one-line status snippet. The modal
 * sheet passes its dialog title and description components so the dialog stays labelled.
 */
export function AgentIdentity({
  title = (name) => <h2 className="text-title-2 text-label-primary">{name}</h2>,
  description = (text) => <p className="text-callout text-label-secondary">{text}</p>,
}: {
  title?: (name: string) => ReactNode;
  description?: (text: string) => ReactNode;
}): ReactElement {
  const persona = usePersona();
  const status = useAgentStatus();
  return (
    <div className="flex min-h-16 items-center gap-3" data-testid="agent-identity">
      <Avatar
        name={persona.name}
        creature={persona.creature}
        {...(persona.imageSrc ? { imageSrc: persona.imageSrc } : {})}
        state={status.state}
        size={64}
        count={status.needsYou}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        {title(persona.name)}
        {description(status.snippet)}
      </div>
    </div>
  );
}

/** What an `/agent/*` route opens: the tab, a task in Activity, a file in Soul & Memory. */
export interface AgentSheetRoute {
  tab: AgentTab;
  taskId?: string;
  /** A task's Timeline (`/agent/activity/run/:runId[?step=:stepId]`, run trace §3.3). */
  runId?: string;
  stepId?: string;
  file?: string;
  /** Soul & Memory opens this person's or project's card (`?entity=`). */
  entity?: string;
  /** Where closing the sheet returns to (`?from=/feed`); the chat when absent. */
  back?: string;
}

/** A same-app path (`/feed`), never a protocol-relative or external URL. */
function appPath(value: string | null): string | undefined {
  return value !== null && /^\/(?![/\\])/.test(value) ? value : undefined;
}

/** `/agent/upcoming?from=%2Ffeed`: the sheet route that returns to `back` when closed. */
export function agentSheetHref(tab: AgentTab, options: { back?: string } = {}): string {
  return options.back === undefined
    ? `/agent/${tab}`
    : `/agent/${tab}?from=${encodeURIComponent(options.back)}`;
}

/** `/agent/activity/run/run_…?step=stp_…`: a task's Timeline in Activity (run trace §3.3). */
export function agentTimelineHref(
  runId: string,
  options: { stepId?: string; back?: string } = {},
): string {
  const query = new URLSearchParams();
  if (options.stepId) query.set("step", options.stepId);
  if (options.back) query.set("from", options.back);
  const qs = query.toString();
  return `/agent/activity/run/${encodeURIComponent(runId)}${qs ? `?${qs}` : ""}`;
}

const ROUTE_TABS: readonly AgentTab[] = ["activity", "approvals", "upcoming", "soul"];

/**
 * Reads `/agent/<tab>[/<taskId>][?file=…][&from=/feed]`. The chat column opens its sheet from this so the
 * routes render the same sheet over the chat, never a full-width page (redesign §5.7).
 */
export function agentSheetRoute(route: string): AgentSheetRoute | null {
  const m = /^\/agent\/(activity|approvals|upcoming|soul)(?:\/run\/([^/?]+)|\/([^/?]+))?/.exec(
    route,
  );
  if (m === null) return null;
  const tab = ROUTE_TABS.find((x) => x === m[1]) ?? "activity";
  const query = new URLSearchParams(route.split("?")[1] ?? "");
  const file = query.get("file") ?? undefined;
  const entity = query.get("entity") ?? undefined;
  const back = appPath(query.get("from"));
  const stepId = query.get("step") ?? undefined;
  return {
    tab,
    ...(m[2] === undefined ? {} : { runId: decodeURIComponent(m[2]) }),
    ...(m[2] !== undefined && stepId ? { stepId } : {}),
    ...(m[3] === undefined ? {} : { taskId: m[3] }),
    ...(file ? { file } : {}),
    ...(entity ? { entity } : {}),
    ...(back ? { back } : {}),
  };
}

export interface AgentSheetBodyProps {
  tab: AgentTab;
  onTabChange: (tab: AgentTab) => void;
  /** Open Activity on this task (`/agent/activity/:taskId`). */
  taskId?: string;
  /** Open Activity on this run's Timeline, at a step (`/agent/activity/run/:runId?step=`). */
  runId?: string;
  stepId?: string;
  now?: number;
  onStartIncognito?: () => void;
  /** Show the avatar, name and status above the tabs (the modal sheet renders its own). */
  header?: boolean;
  /** Soul & Memory opens on this workspace file (`/agent/soul?file=SOUL.md`). */
  file?: string;
  /** Soul & Memory opens this person's or project's card (`/agent/soul?entity=ent_…`). */
  entity?: string;
  /** The `/agent/*` page's × and Escape: back to where the owner came from (#508). */
  onClose?: () => void;
  /**
   * Escape anywhere in the window closes it (the modal sheet, the page). The inline panel turns
   * this off: it sits beside the chat, so Escape in the composer must not close it (#625).
   */
  escapeAnywhere?: boolean;
}

/** The four tabs behind the avatar (UI design §2.3), also used by the `/agent/*` routes. */
export function AgentSheetBody({
  tab,
  onTabChange,
  taskId,
  runId,
  stepId,
  now,
  onStartIncognito,
  header = true,
  file,
  entity,
  onClose,
  escapeAnywhere = true,
}: AgentSheetBodyProps): ReactElement {
  // Escape closes the page unless something on top (a dialog, a menu) already handled it.
  useEffect(() => {
    if (!onClose || !escapeAnywhere) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, escapeAnywhere]);
  // The badge counts what the Approvals panel lists under "Needs you", so the two always agree.
  const { live } = useApprovalQueue();
  return (
    <div className="@container flex min-h-0 flex-1 flex-col gap-4">
      {header ? (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <AgentIdentity />
          </div>
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label={t("common.close")}
              aria-keyshortcuts="Escape"
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(v) => onTabChange(v as AgentTab)}
        className="flex min-h-0 flex-1 flex-col gap-3"
      >
        {/* The tabs are a segmented control under the header (§5.7). */}
        <TabsList aria-label={t("agent.sheet.tabs")} className="w-full">
          <TabsTrigger value="activity" className="min-w-0">
            <ListChecks aria-hidden="true" className="@max-md:hidden" /> {t("agent.sheet.activity")}
          </TabsTrigger>
          <TabsTrigger value="approvals" className="min-w-0">
            <ShieldCheck aria-hidden="true" className="@max-md:hidden" />{" "}
            {t("agent.sheet.approvals")}
            {live.length > 0 ? (
              <Badge variant="approval" className="h-4 px-1.5 tabular-nums">
                {live.length}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="upcoming" className="min-w-0">
            <CalendarClock aria-hidden="true" className="@max-md:hidden" />{" "}
            {t("agent.sheet.upcoming")}
          </TabsTrigger>
          <TabsTrigger value="soul" className="min-w-0">
            <Fingerprint aria-hidden="true" className="@max-md:hidden" /> {t("agent.sheet.soul")}
          </TabsTrigger>
        </TabsList>
        <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-4">
          <TabsContent value="activity">
            <ActivityPanel
              {...(taskId ? { initialTaskId: taskId } : {})}
              {...(runId ? { initialRunId: runId } : {})}
              {...(stepId ? { initialStepId: stepId } : {})}
              {...(now === undefined ? {} : { now })}
            />
          </TabsContent>
          <TabsContent value="approvals">
            <ApprovalsPanel {...(now === undefined ? {} : { now })} />
          </TabsContent>
          <TabsContent value="upcoming">
            <UpcomingPanel {...(now === undefined ? {} : { now })} />
          </TabsContent>
          <TabsContent value="soul">
            <SoulMemoryPanel
              key={`${file ?? ""}|${entity ?? ""}`}
              {...(file ? { initialFile: file } : {})}
              {...(entity ? { initialEntity: entity } : {})}
              {...(onStartIncognito ? { onStartIncognito } : {})}
            />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

/** The inline panel's width (#625): Notes' inspector, beside the content column. */
export const AGENT_PANEL_WIDTH = 400;
/** The content column's narrowest width beside the panel; narrower windows get the modal sheet. */
export const AGENT_PANEL_MIN_CONTENT = 480;

export interface AgentSheetPanelProps
  extends Omit<AgentSheetBodyProps, "header" | "onClose" | "escapeAnywhere"> {
  /** × and Escape (with focus in the panel): back to where the sheet was opened from. */
  onClose: () => void;
}

/**
 * The agent sheet beside the content (#625), like Notes' inspector: the shell gives it a column at
 * the window's trailing edge and the content column shrinks from the right. Non-modal, in the
 * same chrome layer as the canvas (a hairline on its leading edge); its own header row carries
 * the identity and the ×. The shell keeps the modal `AgentSheet` for windows too narrow for both.
 */
export function AgentSheetPanel({ onClose, ...body }: AgentSheetPanelProps): ReactElement {
  return (
    <aside
      aria-label={t("agent.sheet.label")}
      data-testid="agent-sheet"
      data-presentation="inline"
      className="flex h-full min-h-0 w-full flex-col border-s border-separator bg-canvas px-4 pt-4"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        onClose();
      }}
    >
      <AgentSheetBody {...body} header onClose={onClose} escapeAnywhere={false} />
    </aside>
  );
}

export interface AgentSheetProps extends Omit<AgentSheetBodyProps, "header"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Side sheet on wide windows, bottom sheet on narrow ones (§2.3). */
  side?: "right" | "bottom";
}

export function AgentSheet({
  open,
  onOpenChange,
  side = "right",
  ...body
}: AgentSheetProps): ReactElement {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        data-testid="agent-sheet"
        className={cn(
          "gap-0",
          // A 420 px right sheet (redesign §5.7) on the opaque overlay surface at level 3 over a
          // dimming scrim: modal sheets are not glass (materials decision, #584 / A2b); a bottom
          // sheet with a grabber on narrow windows (§5.11).
          side === "right"
            ? "bg-surface-overlay shadow-elevation-3 data-[side=right]:w-full data-[side=right]:border-0 data-[side=right]:sm:max-w-[420px]"
            : "max-h-[85vh] rounded-t-xl bg-surface-overlay pt-2",
        )}
      >
        {side === "bottom" ? (
          <span
            aria-hidden="true"
            className="mx-auto mb-1 h-1 w-9 shrink-0 rounded-full bg-fill-primary"
          />
        ) : null}
        <SheetHeader className="px-5 pt-5 pb-3">
          <AgentIdentity
            title={(name) => (
              <SheetTitle className="text-title-2 text-label-primary">{name}</SheetTitle>
            )}
            description={(text) => (
              <SheetDescription className="text-callout text-label-secondary">
                {text}
              </SheetDescription>
            )}
          />
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col px-5">
          <AgentSheetBody {...body} header={false} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

export interface AgentRouteSheetProps
  extends Omit<
    AgentSheetBodyProps,
    "header" | "tab" | "taskId" | "runId" | "stepId" | "file" | "onClose"
  > {
  route: AgentSheetRoute;
  /** Switches tabs by changing the route, e.g. to `/agent/upcoming`. */
  onTabChange: (tab: AgentTab) => void;
  /** Closing the sheet (×, Escape, the backdrop) leaves the route, e.g. back to `/chat`. */
  onClose: () => void;
  side?: "right" | "bottom";
}

/** The sheet an `/agent/*` route shows: open, over whatever is under it, closing to the chat. */
export function AgentRouteSheet({
  route,
  onTabChange,
  onClose,
  side = "right",
  ...body
}: AgentRouteSheetProps): ReactElement {
  return (
    <AgentSheet
      open
      side={side}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      tab={route.tab}
      onTabChange={onTabChange}
      {...(route.taskId === undefined ? {} : { taskId: route.taskId })}
      {...(route.runId === undefined ? {} : { runId: route.runId })}
      {...(route.stepId === undefined ? {} : { stepId: route.stepId })}
      {...(route.file === undefined ? {} : { file: route.file })}
      {...body}
    />
  );
}
