import type { PermissionMode } from "@psyche/protocol";
import { Bell, ChevronDown, Ellipsis } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Avatar } from "../avatar/Avatar.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { useNotifications } from "../data/index.ts";
import { usePersona } from "../slots.tsx";
import { useAgentStatus } from "./useAgentState.ts";

export const MODE_LABEL: Record<PermissionMode, string> = {
  manual: "manual",
  balanced: "balanced",
  auto: "auto",
  plan: "plan",
};

export interface AgentHeaderProps {
  /** Opens the agent sheet (avatar click). */
  onOpenSheet: () => void;
  /** Opens the current task at level 1 (status snippet click). */
  onOpenTask?: (taskId: string) => void;
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  model?: string;
  onOpenModelPicker?: () => void;
  onOpenInbox?: () => void;
  incognito?: boolean;
  paused?: boolean;
  /** Extra items for the ⋯ menu (export, rename, …). */
  menu?: ReactNode;
}

/**
 * Agent header (UI design §2.3, §3.1): avatar with state ring, persona name, status snippet,
 * counters, permission-mode pill, model pill, bell, ⋯.
 */
export function AgentHeader({
  onOpenSheet,
  onOpenTask,
  mode,
  onModeChange,
  model,
  onOpenModelPicker,
  onOpenInbox,
  incognito = false,
  paused = false,
  menu,
}: AgentHeaderProps): ReactElement {
  const persona = usePersona();
  const status = useAgentStatus({ incognito, paused });
  const { unread } = useNotifications();
  return (
    <header className="flex h-14 items-center gap-3 border-b border-gray-6 px-4">
      <button
        type="button"
        onClick={onOpenSheet}
        className="rounded-full"
        aria-label={`Open ${persona.name}'s activity, approvals, upcoming and memory`}
        aria-keyshortcuts="Meta+Shift+A"
      >
        <Avatar
          name={persona.name}
          creature={persona.creature}
          {...(persona.imageSrc ? { imageSrc: persona.imageSrc } : {})}
          state={status.state}
          count={status.needsYou}
          size={40}
          decorative
        />
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{persona.name}</p>
        <button
          type="button"
          className="block max-w-full truncate text-left text-sm text-muted-foreground hover:text-foreground"
          onClick={() => (status.taskId && onOpenTask ? onOpenTask(status.taskId) : onOpenSheet())}
          aria-live="polite"
        >
          <span className="sr-only">{status.state.replace("-", " ")}: </span>
          {status.snippet}
        </button>
      </div>
      {status.running > 0 ? (
        <span className="text-xs text-muted-foreground">{status.running} running</span>
      ) : null}
      {mode ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                aria-label={`Permission mode: ${mode}`}
                aria-keyshortcuts="Meta+Shift+M"
              />
            }
            disabled={onModeChange === undefined}
          >
            {MODE_LABEL[mode]} <ChevronDown aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => (
              <DropdownMenuItem key={m} onClick={() => onModeChange?.(m)}>
                {MODE_LABEL[m]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {model ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenModelPicker}
          aria-label={`Model: ${model}`}
          aria-keyshortcuts="Meta+Shift+I"
        >
          {model.split("/").pop()}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onOpenInbox}
        aria-label={`Notifications, ${unread.length} unread`}
      >
        <Bell aria-hidden="true" />
        {unread.length > 0 ? (
          <span
            className="absolute -mt-4 ml-4 rounded-full bg-accent-9 px-1 text-[10px] text-accent-contrast"
            aria-hidden="true"
          >
            {unread.length}
          </span>
        ) : null}
      </Button>
      {menu ? (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
            <Ellipsis aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </header>
  );
}
