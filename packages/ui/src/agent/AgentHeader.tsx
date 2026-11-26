import type { PermissionMode } from "@psyche/protocol";
import { Download, Ellipsis, Eraser, LoaderCircle, PanelRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { AVATAR_STATE_LABEL, Avatar, type AvatarState } from "../avatar/Avatar.tsx";
import { DISCLOSURE_KEY, type DisclosureLevel } from "../blocks/disclosure.tsx";
import type { ExportFormat } from "../chat/ExportMenu.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { useStoreState } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { GatewayChip } from "../shell/GatewayChip.tsx";
import { usePersona } from "../slots.tsx";
import { useAgentStatus } from "./useAgentState.ts";

export const MODE_LABEL: Record<PermissionMode, string> = {
  get manual() {
    return t("agent.mode.manual");
  },
  get balanced() {
    return t("agent.mode.balanced");
  },
  get auto() {
    return t("agent.mode.auto");
  },
  get plan() {
    return t("agent.mode.plan");
  },
  get full() {
    return t("agent.mode.full");
  },
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

/** True when the snippet already starts with the state word ("Idle", "Working…", "Needs you: 2"). */
function snippetSaysState(snippet: string, state: AvatarState): boolean {
  return snippet.toLowerCase().startsWith(AVATAR_STATE_LABEL[state].toLowerCase());
}

export interface AgentHeaderProps {
  /** Opens the agent sheet (avatar click). */
  onOpenSheet: () => void;
  /** Opens the current task at level 1 (status snippet click). */
  onOpenTask?: (taskId: string) => void;
  model?: string;
  onOpenModelPicker?: () => void;
  /** The status control's target (the amber count): the approvals list. Defaults to the sheet. */
  onOpenApprovals?: () => void;
  incognito?: boolean;
  paused?: boolean;
  /** Export the open thread (⋯ → Export chat: Markdown / JSON / HTML, §3.2). */
  onExport?: (format: ExportFormat) => void;
  /** Transcript view level (⋯ → Advanced → Transcript view; ⌃O cycles). Replaces the separate "View" strip (§4). */
  disclosure?: DisclosureLevel;
  onDisclosureChange?: (level: DisclosureLevel) => void;
  /** Extra items for the ⋯ menu (rename, fork, …). */
  menu?: ReactNode;
  /** The Space switcher, in the title area after the persona's name (docs/design/spaces-2026.md §7.1). */
  spaceSwitcher?: ReactNode;
  /** The thread's context meter, before the pill group. */
  context?: ReactNode;
  /** ⋯ → Advanced → Context limits… (this chat's own limits). */
  onContextLimits?: () => void;
  /** ⋯ → Advanced → Compact now. */
  onCompact?: () => void;
  /** ⋯ → Clear chat… (the main chat only: it cannot be deleted). */
  onClearChat?: () => void;
  /** Why Clear chat is off right now (the chat is working); the item stays, disabled. */
  clearChatDisabled?: boolean;
}

const LEVELS: readonly DisclosureLevel[] = [0, 1, 2];

/**
 * The chat column's toolbar content (redesign-2026 §4, §5.2): the 20 px avatar with its state
 * ring, the persona name, the status snippet (cross-fades at a fixed width), counters, the bell
 * and ⋯ (model, approvals and memory, export, then Advanced: transcript view, context limits,
 * compact). The permission mode is not here: it is the picker in the composer bar, always visible.
 */
export function AgentHeader({
  onOpenSheet,
  onOpenTask,
  model,
  onOpenModelPicker,
  onOpenApprovals,
  incognito = false,
  paused = false,
  onExport,
  disclosure,
  onDisclosureChange,
  menu,
  spaceSwitcher,
  context,
  onContextLimits,
  onCompact,
  onClearChat,
  clearChatDisabled = false,
}: AgentHeaderProps): ReactElement {
  const persona = usePersona();
  const status = useAgentStatus({ incognito, paused });
  // The snippet names the current work (§3.1); "needs you" is the avatar's count and a counter.
  const step = useStoreState((s) => {
    const task = status.taskId ? s.tasks[status.taskId] : undefined;
    if (task === undefined || (task.status !== "running" && task.status !== "queued")) return null;
    return task.checklist.find((c) => c.status === "in_progress")?.text ?? task.title;
  });
  const hasAdvanced =
    (disclosure !== undefined && onDisclosureChange !== undefined) ||
    onContextLimits !== undefined ||
    onCompact !== undefined;
  const snippet = status.state !== "offline" && step !== null ? step : status.snippet;
  return (
    <div
      role="toolbar"
      aria-label={t("chat.toolbar.label")}
      aria-orientation="horizontal"
      className="@container flex h-13 shrink-0 items-center gap-3 bg-canvas ps-4 pe-3"
      data-testid="chat-toolbar"
    >
      <button
        type="button"
        onClick={onOpenSheet}
        className="shrink-0 cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={t("agent.header.openSheet", { name: persona.name })}
        aria-keyshortcuts="Meta+Shift+A"
        // The startup splash's mark lands here as the app appears (#595).
        data-splash-target=""
      >
        <Avatar
          name={persona.name}
          creature={persona.creature}
          {...(persona.imageSrc ? { imageSrc: persona.imageSrc } : {})}
          state={status.state}
          size={20}
          decorative
        />
      </button>
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <p className="min-w-0 truncate text-headline text-label-primary">{persona.name}</p>
        {spaceSwitcher}
        <GatewayChip />
        {incognito ? (
          <span className="shrink-0 rounded-full border border-dashed border-separator-strong px-2 text-subheadline text-label-secondary">
            {t("chat.toolbar.incognito")}
          </span>
        ) : null}
        {/*
          One polite live region for the state (C13). The state word is said once (#555); sighted
          owners get the one status control on the right (the amber count, or the quiet spinner),
          so the snippet is spoken, not drawn, and the header never says "working" twice.
        */}
        <div role="status" aria-live="polite" data-testid="agent-status" className="sr-only">
          {snippetSaysState(snippet, status.state) ? null : (
            <span>{t("agent.header.stateLead", { state: AVATAR_STATE_LABEL[status.state] })} </span>
          )}
          {snippet}
        </div>
      </div>
      {context}
      {status.needsYou > 0 ? (
        // The one status: an amber dot and how many wait. It opens the approvals list; Home's
        // "Needs you" and the sidebar badge say the same elsewhere, so the header says it once.
        <button
          type="button"
          onClick={onOpenApprovals ?? onOpenSheet}
          className="inline-flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-full px-2.5 text-callout text-label-primary outline-none transition-colors duration-(--duration-micro) ease-(--ease-standard) hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("agent.header.needYou", { n: status.needsYou })}
          data-testid="header-status"
        >
          <span className="size-2 rounded-full bg-approval" aria-hidden="true" />
          <span className="tabular-nums">{status.needsYou}</span>
        </button>
      ) : status.running > 0 ? (
        <button
          type="button"
          onClick={() => (status.taskId && onOpenTask ? onOpenTask(status.taskId) : onOpenSheet())}
          className="inline-flex size-7 shrink-0 cursor-default items-center justify-center rounded-full text-label-secondary outline-none hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("agent.header.running", { n: status.running })}
          data-testid="header-status"
        >
          <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        </button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label={t("common.more")}
            />
          }
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 min-w-56 bg-popover! backdrop-blur-none!">
          {onOpenModelPicker ? (
            <DropdownMenuItem
              onClick={onOpenModelPicker}
              aria-keyshortcuts="Meta+Shift+I"
              aria-label={
                model
                  ? t("agent.header.modelLabel", { model: modelLabel(model) })
                  : t("agent.header.changeModel")
              }
            >
              <span className="flex min-w-0 flex-col">
                {t("agent.header.changeModel")}
                {model ? (
                  <span className="text-callout text-label-secondary" title={model}>
                    {modelLabel(model)}
                  </span>
                ) : null}
              </span>
              <DropdownMenuShortcut>{t("chat.toolbar.keyModel")}</DropdownMenuShortcut>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={onOpenSheet}>
            <PanelRight aria-hidden="true" /> {t("agent.header.menuSheet")}
            <DropdownMenuShortcut>{t("chat.toolbar.keySheet")}</DropdownMenuShortcut>
          </DropdownMenuItem>
          {onExport ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="export-submenu">
                <Download aria-hidden="true" /> {t("agent.header.menuExport")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onClick={() => onExport("markdown")}>
                  {t("agent.header.exportMarkdown")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExport("json")}>
                  {t("agent.header.exportJson")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExport("html")}>
                  {t("agent.header.exportHtml")}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          {menu ? (
            <>
              <DropdownMenuSeparator />
              {menu}
            </>
          ) : null}
          {hasAdvanced ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="advanced-submenu">
                  {t("agent.header.menuAdvanced")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {disclosure !== undefined && onDisclosureChange ? (
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{t("chat.toolbar.view")}</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={String(disclosure)}
                        onValueChange={(v) => onDisclosureChange(Number(v) as DisclosureLevel)}
                      >
                        {LEVELS.map((level) => (
                          <DropdownMenuRadioItem key={level} value={String(level)}>
                            {t(`chat.toolbar.view.${DISCLOSURE_KEY[level]}`)}
                            {level === 0 ? (
                              <DropdownMenuShortcut>
                                {t("chat.toolbar.keyView")}
                              </DropdownMenuShortcut>
                            ) : null}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuGroup>
                  ) : null}
                  {(onContextLimits || onCompact) && disclosure !== undefined ? (
                    <DropdownMenuSeparator />
                  ) : null}
                  {onContextLimits ? (
                    <DropdownMenuItem onClick={onContextLimits}>
                      {t("context.limits.menu")}
                    </DropdownMenuItem>
                  ) : null}
                  {onCompact ? (
                    <DropdownMenuItem onClick={onCompact}>
                      {t("context.meter.compactNow")}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          ) : null}
          {onClearChat ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={clearChatDisabled}
                onClick={onClearChat}
                data-testid="clear-chat-item"
              >
                <Eraser aria-hidden="true" />
                <span className="flex min-w-0 flex-col">
                  {t("chat.clear.menu")}
                  {clearChatDisabled ? (
                    <span className="text-callout text-label-secondary">
                      {t("chat.clear.menuBusy", { persona: persona.name })}
                    </span>
                  ) : null}
                </span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
