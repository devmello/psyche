import type { Idea, IdeaDismissReason } from "@psyche/protocol";
import { ChevronDown, Clock, FileText, Repeat } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Markdown } from "../../blocks/Markdown.tsx";
import { Badge } from "../../components/ui/badge.tsx";
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
   * The one card whose "Let's do it" is the accent primary: the card the user is hovering or
   * focused on (redesign §5.6, the one-primary rule applied to a list). Every other card shows a
   * plain button.
   */
  prominent?: boolean;
  className?: string;
}

/**
 * Idea card (docs/design/redesign-2026.md §5.6): a level-1 card without an outline. Title
 * (text-title-2), "Because:" evidence linked to its source, effort and approvals as callout
 * metadata, the recurring toggle with its cadence, then Let's do it / Edit / Dismiss trailing.
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
  const recurringId = useId();
  const cadenceId = useId();
  const [recurring, setRecurring] = useState(false);
  const [cadence, setCadence] = useState<RecurringCadence>("monthly");
  const schedule = RECURRING_CADENCES.find((c) => c.id === cadence)?.schedule;
  const isSkill = idea.kind === "skill";
  const canRecur = RECURRABLE.has(idea.kind);
  const evidence = readEvidence(idea.evidence);

  return (
    <article
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      data-prominent={prominent || undefined}
      className={cn(
        "flex flex-col gap-3 rounded-lg bg-surface-raised p-4 shadow-elevation-1",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start gap-2">
          <h2 id={titleId} className="min-w-0 flex-1 text-title-2 text-label-primary">
            {idea.title}
          </h2>
          <Badge variant={idea.kind === "skill" ? "accent" : "muted"}>
            {IDEA_KIND_LABEL[idea.kind]}
          </Badge>
        </div>
        {idea.bodyMd.trim() !== "" ? (
          <Markdown className="text-reading text-label-primary">{idea.bodyMd}</Markdown>
        ) : null}
      </div>
      <EvidenceLine items={evidence} {...(onOpenRoute ? { onOpenRoute } : {})} />
      <p className="flex items-center gap-1.5 text-callout text-label-secondary">
        <Clock className="size-4 shrink-0" aria-hidden="true" />
        <span>
          <span className="sr-only">{t("screens.ideas.effort")} </span>
          {idea.effort}
        </span>
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
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {isSkill && onViewSkill ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="me-auto"
            onClick={() => onViewSkill(idea)}
          >
            <FileText aria-hidden="true" />
            {t("screens.ideas.viewSkill")}
          </Button>
        ) : null}
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
          {t("screens.ideas.accept")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || onEdit === undefined}
          onClick={() => onEdit?.(idea)}
        >
          {t("common.edit")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy || onDismiss === undefined}
            render={<Button type="button" size="sm" variant="ghost" />}
          >
            {t("common.dismiss")}
            <ChevronDown aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {DISMISS_OPTIONS.map((o) => (
              <DropdownMenuItem key={o.reason} onClick={() => onDismiss?.(idea, o.reason)}>
                {o.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}
