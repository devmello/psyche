import type { Idea, IdeaDismissReason } from "@psyche/protocol";
import { ChevronDown, Clock, FileText } from "lucide-react";
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

/** Kinds that can become a recurring automation instead of a one-off Task. */
const RECURRABLE: ReadonlySet<Idea["kind"]> = new Set(["task", "automation"]);

export interface IdeaCardProps {
  idea: Idea;
  onAccept?: (idea: Idea, options: { recurring: boolean }) => void;
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
  const [recurring, setRecurring] = useState(false);
  const isSkill = idea.kind === "skill";
  const canRecur = RECURRABLE.has(idea.kind);
  const evidence = readEvidence(idea.evidence);

  return (
    <article
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      className={cn("rounded-lg border border-gray-6 bg-gray-2 p-4 psy-enter", className)}
    >
      <div className="flex flex-wrap items-start gap-2">
        <h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold">
          {idea.title}
        </h2>
        <Badge variant="outline">{IDEA_KIND_LABEL[idea.kind]}</Badge>
      </div>
      {idea.bodyMd.trim() !== "" ? (
        <Markdown className="mt-1 text-sm text-gray-12">{idea.bodyMd}</Markdown>
      ) : null}
      <EvidenceLine items={evidence} className="mt-2" {...(onOpenRoute ? { onOpenRoute } : {})} />
      <p className="mt-1 flex items-center gap-1.5 text-sm text-gray-11">
        <Clock className="size-4 shrink-0" aria-hidden="true" />
        <span>
          <span className="sr-only">Effort: </span>
          {idea.effort}
        </span>
      </p>
      {canRecur ? (
        <div className="mt-3 flex items-center gap-2">
          <Checkbox
            id={recurringId}
            checked={recurring}
            disabled={busy}
            onCheckedChange={(checked) => setRecurring(checked === true)}
          />
          <Label htmlFor={recurringId} className="text-sm font-normal">
            Make recurring
          </Label>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
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
          onClick={() => onAccept?.(idea, { recurring: canRecur && recurring })}
        >
          Let's do it
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || onEdit === undefined}
          onClick={() => onEdit?.(idea)}
        >
          Edit
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy || onDismiss === undefined}
            render={<Button type="button" size="sm" variant="outline" />}
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
