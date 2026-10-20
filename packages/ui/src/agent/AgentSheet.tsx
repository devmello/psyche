import { CalendarClock, Fingerprint, ListChecks, ShieldCheck } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Avatar } from "../avatar/Avatar.tsx";
import { Badge } from "../components/ui/badge.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { t } from "../i18n/core.ts";
import { usePersona } from "../slots.tsx";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { ApprovalsPanel, useApprovalQueue } from "./ApprovalsPanel.tsx";
import { SoulMemoryPanel } from "./SoulMemoryPanel.tsx";
import { UpcomingPanel } from "./UpcomingPanel.tsx";
import { useAgentStatus } from "./useAgentState.ts";

export type AgentTab = "activity" | "approvals" | "upcoming" | "soul";

/**
 * The sheet's header (§2.3, §4.7): the 64 px avatar (which carries the state), the persona's
 * name and the one-line status snippet. The modal sheet passes its dialog title and description components so the
 * dialog stays labelled; the `/agent/*` routes render a plain heading.
 */
export function AgentIdentity({
  title = (name) => <h2 className="text-h2 text-foreground">{name}</h2>,
  description = (text) => <p className="text-small text-muted-foreground">{text}</p>,
}: {
  title?: (name: string) => ReactNode;
  description?: (text: string) => ReactNode;
}): ReactElement {
  const persona = usePersona();
  const status = useAgentStatus();
  return (
    <div className="flex items-center gap-4" data-testid="agent-identity">
      <Avatar
        name={persona.name}
        creature={persona.creature}
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

export interface AgentSheetBodyProps {
  tab: AgentTab;
  onTabChange: (tab: AgentTab) => void;
  /** Open Activity on this task (`/agent/activity/:taskId`). */
  taskId?: string;
  now?: number;
  onStartIncognito?: () => void;
  /** Show the avatar, name and status above the tabs (the modal sheet renders its own). */
  header?: boolean;
}

/** The four tabs behind the avatar (UI design §2.3), also used by the `/agent/*` routes. */
export function AgentSheetBody({
  tab,
  onTabChange,
  taskId,
  now,
  onStartIncognito,
  header = true,
}: AgentSheetBodyProps): ReactElement {
  // The badge counts what the Approvals panel lists under "Needs you", so the two always agree.
  const { live } = useApprovalQueue();
  return (
    <div className="@container flex min-h-0 flex-1 flex-col gap-4">
      {header ? <AgentIdentity /> : null}
      <Tabs
        value={tab}
        onValueChange={(v) => onTabChange(v as AgentTab)}
        className="flex min-h-0 flex-1 flex-col gap-3"
      >
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
            <SoulMemoryPanel {...(onStartIncognito ? { onStartIncognito } : {})} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
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
        className={
          side === "right"
            ? "gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
            : "max-h-[85vh] gap-0"
        }
      >
        <SheetHeader className="px-6 pt-6 pb-4">
          <AgentIdentity
            title={(name) => <SheetTitle className="text-xl font-semibold">{name}</SheetTitle>}
            description={(text) => <SheetDescription>{text}</SheetDescription>}
          />
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col px-6">
          <AgentSheetBody {...body} header={false} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
