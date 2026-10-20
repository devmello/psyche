import type { PermissionMode } from "@psyche/protocol";
import { Bell, ChevronDown, Download, Ellipsis, PanelRight, ShieldCheck } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Avatar } from "../avatar/Avatar.tsx";
import type { ExportFormat } from "../chat/ExportMenu.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { useNotifications, useStoreState } from "../data/index.ts";
import { cn } from "../lib/utils.ts";
import { usePersona } from "../slots.tsx";
import { useAgentStatus } from "./useAgentState.ts";

export const MODE_LABEL: Record<PermissionMode, string> = {
  manual: "manual",
  balanced: "balanced",
  auto: "auto",
  plan: "plan",
};

const ACRONYMS = new Set(["gpt", "glm", "llm", "ai", "vl"]);

/**
 * A readable model name for the pill (§3.1): "anthropic/claude-sonnet-5-5" → "Sonnet 5.5",
 * "openai/gpt-5-mini" → "GPT 5 Mini", "google/gemini-2-5-pro" → "Gemini 2.5 Pro". The full ref
 * stays in the pill's label and tooltip.
 */
export function modelLabel(ref: string): string {
  const name = (ref.split("/").pop() ?? ref).replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const out: string[] = [];
  for (const token of name.split(/[-_\s]+/).filter(Boolean)) {
    const prev = out[out.length - 1];
    if (/^\d+$/.test(token) && prev !== undefined && /\d$/.test(prev) && !prev.includes(".")) {
      out[out.length - 1] = `${prev}.${token}`;
    } else if (ACRONYMS.has(token)) {
      out.push(token.toUpperCase());
    } else {
      out.push(token.charAt(0).toUpperCase() + token.slice(1));
    }
  }
  return out.join(" ") || ref;
}

/** Pills in the header share one quiet, clearly interactive look (no disabled gray). */
const PILL =
  "inline-flex h-7 items-center gap-1 rounded-full border border-gray-6 bg-gray-2 px-2.5 text-small font-medium text-foreground transition-colors hover:border-gray-8 hover:bg-gray-3 [&_svg]:size-3.5 [&_svg]:text-gray-11";

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
  /** Export the open thread (⋯ → Export: Markdown / JSON / HTML, §3.2). */
  onExport?: (format: ExportFormat) => void;
  /** Extra items for the ⋯ menu (rename, …). */
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
  onExport,
  menu,
}: AgentHeaderProps): ReactElement {
  const persona = usePersona();
  const status = useAgentStatus({ incognito, paused });
  const { unread } = useNotifications();
  // The snippet names the current work (§3.1); "needs you" is the avatar's count and a counter.
  const step = useStoreState((s) => {
    const task = status.taskId ? s.tasks[status.taskId] : undefined;
    if (task === undefined || (task.status !== "running" && task.status !== "queued")) return null;
    return task.checklist.find((c) => c.status === "in_progress")?.text ?? task.title;
  });
  const snippet = status.state !== "offline" && step !== null ? step : status.snippet;
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-gray-6 px-4">
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
        >
          <span className="sr-only">{status.state.replace("-", " ")}: </span>
          {snippet}
        </button>
        {/* Run status for screen readers, beside the button rather than on it (C13). */}
        <span className="sr-only" role="status">
          {status.state.replace("-", " ")}
        </span>
      </div>
      {status.running > 0 || status.needsYou > 0 ? (
        <p className="hidden items-center gap-2 text-caption text-muted-foreground sm:flex">
          {status.running > 0 ? <span>{status.running} running</span> : null}
          {status.needsYou > 0 && step !== null ? (
            <button
              type="button"
              onClick={onOpenSheet}
              className="rounded-sm text-approval-text hover:underline"
            >
              {status.needsYou} need{status.needsYou === 1 ? "s" : ""} you
            </button>
          ) : null}
        </p>
      ) : null}
      {mode ? (
        onModeChange ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={PILL}
              aria-label={`Permission mode: ${mode}`}
              aria-keyshortcuts="Meta+Shift+M"
            >
              <ShieldCheck aria-hidden="true" />
              {MODE_LABEL[mode]}
              <ChevronDown aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={mode}
                onValueChange={(m) => onModeChange(m as PermissionMode)}
              >
                {(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => (
                  <DropdownMenuRadioItem key={m} value={m}>
                    {MODE_LABEL[m]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          // Read-only here (no handler): a plain chip, not a disabled button.
          <span className={cn(PILL, "hover:border-gray-6 hover:bg-gray-2")}>
            <ShieldCheck aria-hidden="true" />
            <span className="sr-only">Permission mode: </span>
            {MODE_LABEL[mode]}
          </span>
        )
      ) : null}
      {model ? (
        onOpenModelPicker ? (
          <button
            type="button"
            className={PILL}
            onClick={onOpenModelPicker}
            aria-label={`Model: ${modelLabel(model)}`}
            title={model}
            aria-keyshortcuts="Meta+Shift+I"
          >
            {modelLabel(model)}
            <ChevronDown aria-hidden="true" />
          </button>
        ) : (
          <span className={cn(PILL, "hover:border-gray-6 hover:bg-gray-2")} title={model}>
            <span className="sr-only">Model: </span>
            {modelLabel(model)}
          </span>
        )
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
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onOpenSheet}>
            <PanelRight aria-hidden="true" /> Activity, approvals and memory
          </DropdownMenuItem>
          {onOpenModelPicker ? (
            <DropdownMenuItem onClick={onOpenModelPicker}>Change model…</DropdownMenuItem>
          ) : null}
          {onExport ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onExport("markdown")}>
                <Download aria-hidden="true" /> Export as Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("json")}>
                <Download aria-hidden="true" /> Export as JSON
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("html")}>
                <Download aria-hidden="true" /> Export as HTML
              </DropdownMenuItem>
            </>
          ) : null}
          {menu ? (
            <>
              <DropdownMenuSeparator />
              {menu}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
