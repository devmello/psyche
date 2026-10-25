import type { PermissionMode } from "@psyche/protocol";
import { Bell, ChevronDown, Download, Ellipsis, PanelRight, ShieldCheck } from "lucide-react";
import * as m from "motion/react-m";
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
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { useNotifications, useStoreState } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { fade, Presence } from "../motion/index.ts";
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

/** One segment of the toolbar's mode / model pill group (§4, §5.2). */
const SEGMENT =
  "inline-flex h-7 cursor-default items-center gap-1 px-3 text-body text-label-primary transition-colors duration-(--duration-micro) ease-(--ease-standard) outline-none hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-expanded:bg-fill-secondary [&_svg]:size-3.5 [&_svg]:text-label-secondary";
/** The same segment when there is no handler: text, not a disabled control. */
const SEGMENT_STATIC = "inline-flex h-7 items-center gap-1 px-3 text-body text-label-secondary";

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
  /** Transcript view level (⋯ → View; ⌃O cycles). Replaces the separate "View" strip (§4). */
  disclosure?: DisclosureLevel;
  onDisclosureChange?: (level: DisclosureLevel) => void;
  /** Extra items for the ⋯ menu (rename, fork, …). */
  menu?: ReactNode;
  /** The thread's context meter, before the pill group. */
  context?: ReactNode;
  /** ⋯ → Context limits… (this chat's own limits). */
  onContextLimits?: () => void;
  /** ⋯ → Compact now. */
  onCompact?: () => void;
}

const LEVELS: readonly DisclosureLevel[] = [0, 1, 2];

/**
 * The chat column's toolbar content (redesign-2026 §4, §5.2): the 28 px avatar with its state
 * ring, the persona name, the status snippet (cross-fades at a fixed width), counters, the mode
 * and model pill group, the bell and ⋯ (agent sheet, model, view level, context, export). The
 * separate "View" strip is gone: the transcript view level lives in ⋯ and on ⌃O.
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
  disclosure,
  onDisclosureChange,
  menu,
  context,
  onContextLimits,
  onCompact,
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
  const pills = mode !== undefined || model !== undefined;
  return (
    <div
      role="toolbar"
      aria-label={t("chat.toolbar.label")}
      aria-orientation="horizontal"
      className="flex h-13 shrink-0 items-center gap-3 bg-canvas ps-4 pe-3"
      data-testid="chat-toolbar"
    >
      <button
        type="button"
        onClick={onOpenSheet}
        className="shrink-0 cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={t("agent.header.openSheet", { name: persona.name })}
        aria-keyshortcuts="Meta+Shift+A"
      >
        <Avatar
          name={persona.name}
          creature={persona.creature}
          {...(persona.imageSrc ? { imageSrc: persona.imageSrc } : {})}
          state={status.state}
          count={status.needsYou}
          size={28}
          decorative
        />
      </button>
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <p className="shrink-0 text-headline text-label-primary">{persona.name}</p>
        {incognito ? (
          <span className="shrink-0 rounded-full border border-dashed border-separator-strong px-2 text-subheadline text-label-secondary">
            {t("chat.toolbar.incognito")}
          </span>
        ) : null}
        {/*
          One polite live region around the snippet (C13: the region holds the button, it is
          not on it). The state word is said once (#555). The text cross-fades in place at a
          fixed width (motion.md §3: it never moves).
        */}
        <div
          role="status"
          aria-live="polite"
          data-testid="agent-status"
          className="relative min-w-0 max-w-[36ch] flex-1"
        >
          <button
            type="button"
            className="block w-full cursor-default truncate rounded-sm text-start text-callout text-label-secondary outline-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() =>
              status.taskId && onOpenTask ? onOpenTask(status.taskId) : onOpenSheet()
            }
          >
            {snippetSaysState(snippet, status.state) ? null : (
              <span className="sr-only">
                {t("agent.header.stateLead", { state: AVATAR_STATE_LABEL[status.state] })}{" "}
              </span>
            )}
            <Presence mode="popLayout" initial={false}>
              <m.span key={snippet} className="inline" {...fade}>
                {snippet}
              </m.span>
            </Presence>
          </button>
        </div>
      </div>
      {status.running > 0 || status.needsYou > 0 ? (
        <p className="hidden shrink-0 items-center gap-2 text-callout text-label-secondary md:flex">
          {status.running > 0 ? (
            <span>{t("agent.header.running", { n: status.running })}</span>
          ) : null}
          {status.needsYou > 0 && step !== null ? (
            <button
              type="button"
              onClick={onOpenSheet}
              className="cursor-default rounded-sm text-approval-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("agent.header.needYou", { n: status.needsYou })}
            </button>
          ) : null}
        </p>
      ) : null}
      {context}
      {pills ? (
        // The mode and model pills are one glass control group (§4), concentric capsules.
        <div
          className="material-glass flex shrink-0 items-center overflow-hidden rounded-full"
          data-testid="toolbar-pills"
        >
          {mode ? (
            onModeChange ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={SEGMENT}
                  aria-label={t("agent.header.modeLabel", { mode: MODE_LABEL[mode] })}
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
              <span className={SEGMENT_STATIC}>
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                <span className="sr-only">{t("agent.header.modeLead")} </span>
                {MODE_LABEL[mode]}
              </span>
            )
          ) : null}
          {mode && model ? (
            <span className="h-4 w-px shrink-0 bg-separator" aria-hidden="true" />
          ) : null}
          {model ? (
            onOpenModelPicker ? (
              <button
                type="button"
                className={SEGMENT}
                onClick={onOpenModelPicker}
                aria-label={t("agent.header.modelLabel", { model: modelLabel(model) })}
                title={model}
                aria-keyshortcuts="Meta+Shift+I"
              >
                {modelLabel(model)}
                <ChevronDown aria-hidden="true" />
              </button>
            ) : (
              <span className={SEGMENT_STATIC} title={model}>
                <span className="sr-only">{t("agent.header.modelLead")} </span>
                {modelLabel(model)}
              </span>
            )
          ) : null}
        </div>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        className="relative"
        onClick={onOpenInbox}
        aria-label={t("agent.header.notifications", { n: unread.length })}
      >
        <Bell aria-hidden="true" />
        {unread.length > 0 ? (
          <span
            className="absolute -top-0.5 -end-0.5 min-w-4 rounded-full bg-accent-9 px-1 text-center text-[11px] leading-4 text-accent-contrast tabular-nums"
            aria-hidden="true"
          >
            {unread.length}
          </span>
        ) : null}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={t("common.more")} />}
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuItem onClick={onOpenSheet}>
            <PanelRight aria-hidden="true" /> {t("agent.header.menuSheet")}
            <DropdownMenuShortcut>{t("chat.toolbar.keySheet")}</DropdownMenuShortcut>
          </DropdownMenuItem>
          {onOpenModelPicker ? (
            <DropdownMenuItem onClick={onOpenModelPicker}>
              {t("agent.header.changeModel")}
              <DropdownMenuShortcut>{t("chat.toolbar.keyModel")}</DropdownMenuShortcut>
            </DropdownMenuItem>
          ) : null}
          {disclosure !== undefined && onDisclosureChange ? (
            <>
              <DropdownMenuSeparator />
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
                        <DropdownMenuShortcut>{t("chat.toolbar.keyView")}</DropdownMenuShortcut>
                      ) : null}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </>
          ) : null}
          {onContextLimits || onCompact ? (
            <>
              <DropdownMenuSeparator />
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
            </>
          ) : null}
          {onExport ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onExport("markdown")}>
                <Download aria-hidden="true" /> {t("agent.header.exportMarkdown")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("json")}>
                <Download aria-hidden="true" /> {t("agent.header.exportJson")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("html")}>
                <Download aria-hidden="true" /> {t("agent.header.exportHtml")}
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
    </div>
  );
}
