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
import { cn } from "../../lib/utils.ts";
import { EvidenceLine, readEvidence } from "./evidence.tsx";

export const IDEA_KIND_LABEL: Record<Idea["kind"], string> = {
  task: "Task",
  automation: "Automation",
  skill: "Skill draft",
  goal: "Goal",
  connector: "Connector",
};

export const DISMISS_OPTIONS: readonly { reason: IdeaDismissReason; label: string }[] = [
  { reason: "not_now", label: "Not now" },
  { reason: "not_interested", label: "Not interested" },
  { reason: "never_from_source", label: "Never from this source" },
];

/**
 * Task ideas can become a recurring automation instead of a one-off Task; the Gateway needs a
 * schedule for that (`ideas.accept` `schedule`). Automation ideas already recur on the schedule
 * they propose, so they show no toggle.
 */
const RECURRABLE: ReadonlySet<Idea["kind"]> = new Set(["task"]);

export const RECURRING_CADENCES = [
  { id: "daily", label: "daily", schedule: "0 8 * * *" },
  { id: "weekly", label: "weekly", schedule: "0 9 * * 1" },
  { id: "monthly", label: "monthly", schedule: "0 9 1 * *" },
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
  className?: string;
}

/**
 * Idea card (UI design §3.10): title, "Because:" evidence linked to its source, effort, a
 * recurring toggle, then Let's do it / Edit / Dismiss in a fixed order.
 */
export function IdeaCard({
  idea,
  onAccept,
  onEdit,
  onDismiss,
  onViewSkill,
  onOpenRoute,
  busy = false,
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
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-gray-6 bg-gray-2 px-5 py-4 psy-enter",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start gap-2">
          <h2 id={titleId} className="min-w-0 flex-1 text-h3 text-foreground">
            {idea.title}
          </h2>
          <Badge variant={idea.kind === "skill" ? "accent" : "muted"}>
            {IDEA_KIND_LABEL[idea.kind]}
          </Badge>
        </div>
        {idea.bodyMd.trim() !== "" ? (
          <Markdown className="text-body text-gray-12">{idea.bodyMd}</Markdown>
        ) : null}
      </div>
      <EvidenceLine items={evidence} {...(onOpenRoute ? { onOpenRoute } : {})} />
      <p className="flex items-center gap-1.5 text-small text-gray-11">
        <Clock className="size-4 shrink-0" aria-hidden="true" />
        <span>
          <span className="sr-only">Effort: </span>
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
          <Label htmlFor={recurringId} className="text-small font-normal">
            Make recurring
          </Label>
          <label htmlFor={cadenceId} className="sr-only">
            Cadence
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
        <p className="flex items-center gap-1.5 text-small text-gray-11">
          <Repeat className="size-4 shrink-0" aria-hidden="true" />
          Repeats on the schedule it proposes; change it later in Upcoming.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {isSkill && onViewSkill ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mr-auto"
            onClick={() => onViewSkill(idea)}
          >
            <FileText aria-hidden="true" />
            View SKILL.md
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
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
          Let's do it
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || onEdit === undefined}
          onClick={() => onEdit?.(idea)}
        >
          Edit
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy || onDismiss === undefined}
            render={<Button type="button" size="sm" variant="ghost" />}
          >
            Dismiss
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
