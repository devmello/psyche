import { ArrowRight, Fingerprint, ShieldCheck, X } from "lucide-react";
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
import { useQuestions } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { routeLink } from "../overview/overviewLinks.ts";
import { usePersona, useSlots } from "../slots.tsx";
import { ApprovalsPanel, useApprovalQueue } from "./ApprovalsPanel.tsx";
import { NowNextLine } from "./NowNextLine.tsx";
import { SoulMemoryPanel } from "./SoulMemoryPanel.tsx";
import { useAgentStatus } from "./useAgentState.ts";

/** The two segments of the sheet (agent-overview-2026 §4.1). */
export type AgentTab = "approvals" | "soul";
/** Tabs an old link may name: Activity, Upcoming and Growth moved to the Overview. */
export type LegacyAgentTab = "activity" | "upcoming" | "growth";
export type AgentRouteTab = AgentTab | LegacyAgentTab;

/** The segment a route opens; the moved tabs fall back to Approvals (they redirect anyway). */
export const sheetTab = (tab: AgentRouteTab): AgentTab => (tab === "soul" ? "soul" : "approvals");

const LAST_TAB_KEY = "psyche.agentSheet.tab";

/** The segment used last on this device, or null. Storage can throw or be empty. */
export function lastAgentTab(): AgentTab | null {
  try {
    const v = window.localStorage.getItem(LAST_TAB_KEY);
    return v === "approvals" || v === "soul" ? v : null;
  } catch {
    return null;
  }
}

export function rememberAgentTab(tab: AgentTab): void {
  try {
    window.localStorage.setItem(LAST_TAB_KEY, tab);
  } catch {
    // A private window or blocked storage: the sheet still works.
  }
}

/** What approvals and questions are waiting: the Approvals badge and the default segment. */
export function useNeedsYouCount(): number {
  const { live } = useApprovalQueue();
  const questions = useQuestions();
  return live.length + questions.open.length;
}

/** Approvals when something needs you, otherwise the segment used last (else Approvals). */
export function useDefaultAgentTab(): AgentTab {
  const count = useNeedsYouCount();
  return count > 0 ? "approvals" : (lastAgentTab() ?? "approvals");
}

/**
 * The sheet's header (redesign §5.7, docs/06 §4.7): the 64 px avatar (which carries the state),
 * the persona's name in text-title-2 and the state with the one-line status snippet. The modal
 * sheet passes its dialog title and description components so the dialog stays labelled.
 */
export function AgentIdentity({
  title = (name) => <h2 className="text-title-2 text-label-primary">{name}</h2>,
  description = (line) => <div>{line}</div>,
  now,
}: {
  title?: (name: string) => ReactNode;
  /** Wraps the Now / next line; the modal sheet passes its dialog description. */
  description?: (line: ReactNode) => ReactNode;
  now?: number;
}): ReactElement {
  const persona = usePersona();
  const status = useAgentStatus();
  const navigate = useSlots().navigate;
  // A plain click goes in-app (closing the sheet); a ⌘-click follows the link and keeps it open.
  const overview = routeLink("/overview", navigate);
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
        {description(<NowNextLine {...(now === undefined ? {} : { now })} />)}
        <a
          href={overview.href}
          onClick={overview.onClick}
          data-testid="agent-open-overview"
          className="inline-flex w-fit items-center gap-1 rounded-sm text-callout text-accent-11 underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("agent.sheet.openOverview")}
          <ArrowRight aria-hidden="true" className="size-3.5 rtl:rotate-180" />
        </a>
      </div>
    </div>
  );
}

/** What an `/agent/*` route opens: the tab, a file or a person in Soul & Memory. */
export interface AgentSheetRoute {
  /** The moved tabs still parse so old links resolve (the shell redirects them). */
  tab: AgentRouteTab;
  /** `/agent/approvals?view=decided` (or `#decided`) opens "Decided recently" expanded. */
  view?: "decided";
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

/** `/agent/approvals?view=decided&from=%2Ffeed`: the sheet route that returns to `back` when closed. */
export function agentSheetHref(
  tab: AgentTab,
  options: { back?: string; view?: "decided" } = {},
): string {
  const query = new URLSearchParams();
  if (options.view) query.set("view", options.view);
  if (options.back !== undefined) query.set("from", options.back);
  const qs = query.toString();
  return qs ? `/agent/${tab}?${qs}` : `/agent/${tab}`;
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

const ROUTE_TABS: readonly AgentRouteTab[] = [
  "activity",
  "approvals",
  "upcoming",
  "soul",
  "growth",
];

/**
 * Reads `/agent/<tab>[/<taskId>][?file=…][&from=/feed]`. The chat column opens its sheet from this so the
 * routes render the same sheet over the chat, never a full-width page (redesign §5.7).
 */
export function agentSheetRoute(route: string): AgentSheetRoute | null {
  const m =
    /^\/agent\/(activity|approvals|upcoming|soul|growth)(?:\/run\/([^/?]+)|\/([^/?]+))?/.exec(
      route,
    );
  if (m === null) return null;
  const tab = ROUTE_TABS.find((x) => x === m[1]) ?? "approvals";
  const [beforeHash = "", hash] = route.split("#");
  const query = new URLSearchParams(beforeHash.split("?")[1] ?? "");
  const decided = tab === "approvals" && (query.get("view") === "decided" || hash === "decided");
  const file = query.get("file") ?? undefined;
  const entity = query.get("entity") ?? undefined;
  const back = appPath(query.get("from"));
  const stepId = query.get("step") ?? undefined;
  return {
    tab,
    ...(decided ? { view: "decided" as const } : {}),
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
  /** Approvals opens "Decided recently" expanded (`/agent/approvals?view=decided`). */
  view?: "decided";
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

/** The two segments behind the avatar (agent-overview-2026 §4.1), also used by `/agent/*` routes. */
export function AgentSheetBody({
  tab,
  onTabChange,
  view,
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
  // The badge counts what the Approvals panel lists under "Needs you" and Questions.
  const needs = useNeedsYouCount();
  return (
    <div className="@container flex min-h-0 flex-1 flex-col gap-4">
      {header ? (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <AgentIdentity {...(now === undefined ? {} : { now })} />
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
        onValueChange={(v) => {
          rememberAgentTab(v as AgentTab);
          onTabChange(v as AgentTab);
        }}
        className="flex min-h-0 flex-1 flex-col gap-3"
      >
        {/* Two segments, full width: about 190 px per label at 420 px (§4.1). */}
        <TabsList aria-label={t("agent.sheet.tabs")} className="w-full">
          <TabsTrigger value="approvals" className="min-w-0 flex-1">
            <ShieldCheck aria-hidden="true" className="@max-md:hidden" />{" "}
            {t("agent.sheet.approvals")}
            {needs > 0 ? (
              <Badge variant="approval" className="h-4 px-1.5 tabular-nums">
                {needs}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="soul" className="min-w-0 flex-1">
            <Fingerprint aria-hidden="true" className="@max-md:hidden" /> {t("agent.sheet.soul")}
          </TabsTrigger>
        </TabsList>
        <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-4">
          <TabsContent value="approvals">
            <ApprovalsPanel
              {...(now === undefined ? {} : { now })}
              {...(view === "decided" ? { decided: true } : {})}
            />
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
        // Focus lands on the selected segment, not on the Now / next link under the name.
        initialFocus={() =>
          document.querySelector<HTMLElement>(
            '[data-testid="agent-sheet"] [role="tab"][aria-selected="true"]',
          )
        }
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
            {...(body.now === undefined ? {} : { now: body.now })}
            title={(name) => (
              <SheetTitle className="text-title-2 text-label-primary">{name}</SheetTitle>
            )}
            description={(line) => (
              <SheetDescription className="text-callout text-label-secondary" render={<div />}>
                {line}
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
  extends Omit<AgentSheetBodyProps, "header" | "tab" | "view" | "file" | "onClose"> {
  route: AgentSheetRoute;
  /** Switches tabs by changing the route, e.g. to `/agent/soul`. */
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
      tab={sheetTab(route.tab)}
      onTabChange={onTabChange}
      {...(route.view === undefined ? {} : { view: route.view })}
      {...(route.file === undefined ? {} : { file: route.file })}
      {...body}
    />
  );
}
