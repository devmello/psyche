import type { Idea, IdeaDismissReason } from "@psyche/protocol";
import { Clock, Ellipsis, Repeat } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Markdown } from "../../blocks/Markdown.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { EvidenceLine, readEvidence } from "./evidence.tsx";

export const IDEA_KIND_LABEL: Record<Idea["kind"], string> = {
  get task() {
    return t("screens.ideas.kind.task");
  },
  get automation() {
    return t("screens.ideas.kind.automation");
  },
  get skill() {
    return t("screens.ideas.kind.skill");
  },
  get goal() {
    return t("screens.ideas.kind.goal");
  },
  get connector() {
    return t("screens.ideas.kind.connector");
  },
};

/** Which goal card an idea is, read from its evidence (`goal_checkin`, `goal_stalled`). */
export function goalCardKind(idea: Pick<Idea, "evidence">): "checkin" | "resume" | null {
  for (const e of idea.evidence) {
    if (e.type === "goal_checkin") return "checkin";
    if (e.type === "goal_stalled") return "resume";
  }
  return null;
}

export const DISMISS_OPTIONS: readonly { reason: IdeaDismissReason; label: string }[] = [
  {
    reason: "not_now",
    get label() {
      return t("screens.ideas.dismiss.notNow");
    },
  },
  {
    reason: "not_interested",
    get label() {
      return t("screens.ideas.dismiss.notInterested");
    },
  },
  {
    reason: "never_from_source",
    get label() {
      return t("screens.ideas.dismiss.neverFromSource");
    },
  },
];

/**
 * Task ideas can become a recurring automation instead of a one-off Task; the Gateway needs a
 * schedule for that (`ideas.accept` `schedule`). Automation ideas already recur on the schedule
 * they propose, so they show no toggle.
 */
const RECURRABLE: ReadonlySet<Idea["kind"]> = new Set(["task"]);

export const RECURRING_CADENCES = [
  {
    id: "daily",
    get label() {
      return t("screens.ideas.cadence.daily");
    },
    schedule: "0 8 * * *",
  },
  {
    id: "weekly",
    get label() {
      return t("screens.ideas.cadence.weekly");
    },
    schedule: "0 9 * * 1",
  },
  {
    id: "monthly",
    get label() {
      return t("screens.ideas.cadence.monthly");
    },
    schedule: "0 9 1 * *",
  },
] as const;

export type RecurringCadence = (typeof RECURRING_CADENCES)[number]["id"];

export interface IdeaAcceptOptions {
  recurring: boolean;
  /** Cron schedule for a recurring accept. */
  schedule?: string;
}

export interface IdeaCardProps {
  idea: Idea;
  onAccept?: (idea: Idea, options: IdeaAcceptOptions) => void;
  onEdit?: (idea: Idea) => void;
  onDismiss?: (idea: Idea, reason: IdeaDismissReason) => void;
  /** Skill drafts: open `SKILL.md`. */
  onViewSkill?: (idea: Idea) => void;
  onOpenRoute?: (route: string) => void;
  /** The idea is being accepted or dismissed. */
  busy?: boolean;
  /**
   * The one row whose "Do it" is the accent primary: the first in the list (one primary per
   * view). Every other row shows the outline button.
   */
  prominent?: boolean;
  className?: string;
}

/** The first line of an idea's body as plain text: no markdown marks, links as their text. */
export function plainFirstLine(markdown: string): string {
  for (const raw of markdown.split("\n")) {
    const line = raw
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^[\s>#*+-]+/, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (line !== "") return line;
  }
  return "";
}

/**
 * A suggestion as one quiet row: the title, one line of what it is, and one action ("Do it", or
 * "Start" on a goal card). Edit, the dismiss reasons and "make recurring" sit in the "..." menu;
 * the whole body, the "Because" evidence and the effort open under the row when the title is
 * pressed (keyboard: Enter on the title).
 */
export function IdeaCard({
  idea,
  onAccept,
  onEdit,
  onDismiss,
  onViewSkill,
  onOpenRoute,
  busy = false,
  prominent = false,
  className,
}: IdeaCardProps): ReactElement {
  const titleId = useId();
  const detailId = useId();
  const recurringId = useId();
  const cadenceId = useId();
  const [open, setOpen] = useState(false);
  const [recurring, setRecurring] = useState(false);
  const [cadence, setCadence] = useState<RecurringCadence>("monthly");
  const schedule = RECURRING_CADENCES.find((c) => c.id === cadence)?.schedule;
  const isSkill = idea.kind === "skill";
  // Goal cards (a check-in's next step, a stalled task's "Resume?"): Start, Snooze, Dismiss.
  const goalCard = goalCardKind(idea);
  const canRecur = RECURRABLE.has(idea.kind) && goalCard === null;
  const evidence = readEvidence(idea.evidence);
  const goalLabel =
    goalCard === "resume"
      ? t("screens.ideas.badge.resume")
      : goalCard === "checkin"
        ? t("screens.ideas.badge.checkin")
        : null;
  const summary = plainFirstLine(idea.bodyMd);
  // One secondary line: the goal card's question, then what it is about.
  const secondary = [goalLabel, summary === "" ? idea.effort : summary]
    .filter((x): x is string => x !== null && x !== "")
    .join(" · ");
  const cannotDismiss = busy || onDismiss === undefined;

  return (
    <article
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      data-prominent={prominent || undefined}
      className={cn(
        "flex flex-col rounded-lg transition-colors hover:bg-fill-quaternary",
        className,
      )}
    >
      <div className="flex min-h-11 items-center gap-2 ps-2.5 pe-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 flex-col justify-center rounded-sm py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span id={titleId} className="truncate text-body text-label-primary">
            {idea.title}
          </span>
          {secondary !== "" ? (
            <span className="truncate text-callout text-label-secondary">{secondary}</span>
          ) : null}
        </button>
        <Button
          type="button"
          size="sm"
          variant={prominent ? "default" : "outline"}
          disabled={busy || onAccept === undefined}
          onClick={() =>
            onAccept?.(
              idea,
              canRecur && recurring && schedule !== undefined
                ? { recurring: true, schedule }
                : { recurring: false },
            )
          }
        >
          {goalCard === null ? t("screens.ideas.accept") : t("screens.ideas.start")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            aria-label={t("screens.ideas.options", { title: idea.title })}
            title={t("screens.ideas.options", { title: idea.title })}
            render={<Button type="button" size="icon-sm" variant="ghost" />}
          >
            <Ellipsis aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {goalCard === null && onEdit !== undefined ? (
              <DropdownMenuItem onClick={() => onEdit(idea)}>{t("common.edit")}</DropdownMenuItem>
            ) : null}
            {isSkill && onViewSkill ? (
              <DropdownMenuItem onClick={() => onViewSkill(idea)}>
                {t("screens.ideas.viewSkill")}
              </DropdownMenuItem>
            ) : null}
            {canRecur ? (
              <DropdownMenuItem
                onClick={() => {
                  setRecurring(true);
                  setOpen(true);
                }}
              >
                {t("screens.ideas.makeRecurring")}
              </DropdownMenuItem>
            ) : null}
            {goalCard === null ? (
              DISMISS_OPTIONS.map((o) => (
                <DropdownMenuItem
                  key={o.reason}
                  disabled={cannotDismiss}
                  onClick={() => onDismiss?.(idea, o.reason)}
                >
                  {o.label}
                </DropdownMenuItem>
              ))
            ) : (
              <>
                <DropdownMenuItem
                  disabled={cannotDismiss}
                  onClick={() => onDismiss?.(idea, "not_now")}
                >
                  {t("screens.ideas.snooze")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={cannotDismiss}
                  onClick={() => onDismiss?.(idea, "not_interested")}
                >
                  {t("common.dismiss")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open ? (
        <div id={detailId} className="flex flex-col gap-3 px-2.5 pt-1 pb-3">
          {idea.bodyMd.trim() !== "" ? (
            <Markdown className="text-reading text-label-primary">{idea.bodyMd}</Markdown>
          ) : null}
          <EvidenceLine items={evidence} {...(onOpenRoute ? { onOpenRoute } : {})} />
          <p className="flex items-center gap-1.5 text-callout text-label-secondary">
            <Clock className="size-4 shrink-0" aria-hidden="true" />
            <span>
              <span className="sr-only">{t("screens.ideas.effort")} </span>
              {idea.effort}
            </span>
            <span aria-hidden="true">·</span>
            <span>{IDEA_KIND_LABEL[idea.kind]}</span>
          </p>
          {canRecur ? (
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox
                id={recurringId}
                checked={recurring}
                disabled={busy}
                onCheckedChange={(checked) => setRecurring(checked === true)}
              />
              <Label htmlFor={recurringId} className="text-body font-normal">
                {t("screens.ideas.makeRecurring")}
              </Label>
              <label htmlFor={cadenceId} className="sr-only">
                {t("screens.ideas.cadence")}
              </label>
              <NativeSelect
                id={cadenceId}
                size="sm"
                value={cadence}
                disabled={busy}
                onChange={(e) => {
                  const next = RECURRING_CADENCES.find((c) => c.id === e.target.value);
                  if (next) setCadence(next.id);
                }}
              >
                {RECURRING_CADENCES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : idea.kind === "automation" ? (
            <p className="flex items-center gap-1.5 text-callout text-label-secondary">
              <Repeat className="size-4 shrink-0" aria-hidden="true" />
              {t("screens.ideas.repeats")}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
