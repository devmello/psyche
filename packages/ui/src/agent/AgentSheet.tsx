import { CalendarClock, Fingerprint, ListChecks, ShieldCheck } from "lucide-react";
import type { ReactElement } from "react";
import { Avatar } from "../avatar/Avatar.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { usePersona } from "../slots.tsx";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { ApprovalsPanel } from "./ApprovalsPanel.tsx";
import { SoulMemoryPanel } from "./SoulMemoryPanel.tsx";
import { UpcomingPanel } from "./UpcomingPanel.tsx";
import { useAgentStatus } from "./useAgentState.ts";

export type AgentTab = "activity" | "approvals" | "upcoming" | "soul";

export interface AgentSheetBodyProps {
  tab: AgentTab;
  onTabChange: (tab: AgentTab) => void;
  /** Open Activity on this task (`/agent/activity/:taskId`). */
  taskId?: string;
  now?: number;
  onStartIncognito?: () => void;
}

/** The four tabs behind the avatar (UI design §2.3), also used by the `/agent/*` routes. */
export function AgentSheetBody({
  tab,
  onTabChange,
  taskId,
  now,
  onStartIncognito,
}: AgentSheetBodyProps): ReactElement {
  const status = useAgentStatus();
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => onTabChange(v as AgentTab)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabsList aria-label="Agent" className="w-full">
        <TabsTrigger value="activity">
          <ListChecks aria-hidden="true" /> Activity
        </TabsTrigger>
        <TabsTrigger value="approvals">
          <ShieldCheck aria-hidden="true" /> Approvals
          {status.needsYou > 0 ? (
            <span className="ml-1 rounded-full bg-approval px-1.5 text-xs text-gray-12">
              {status.needsYou}
            </span>
          ) : null}
        </TabsTrigger>
        <TabsTrigger value="upcoming">
          <CalendarClock aria-hidden="true" /> Upcoming
        </TabsTrigger>
        <TabsTrigger value="soul">
          <Fingerprint aria-hidden="true" /> Soul & Memory
        </TabsTrigger>
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto pt-3">
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
  );
}

export interface AgentSheetProps extends AgentSheetBodyProps {
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
  const persona = usePersona();
  const status = useAgentStatus();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        className={side === "right" ? "w-full sm:max-w-xl" : "max-h-[85vh]"}
      >
        <SheetHeader className="flex-row items-center gap-3">
          <Avatar
            name={persona.name}
            creature={persona.creature}
            state={status.state}
            size={64}
            count={status.needsYou}
          />
          <div>
            <SheetTitle>{persona.name}</SheetTitle>
            <SheetDescription>{status.snippet}</SheetDescription>
          </div>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
          <AgentSheetBody {...body} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
