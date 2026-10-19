import type { ChecklistItem, PlanStep } from "@psyche/protocol";
import { Check, Circle, CircleDashed, X } from "lucide-react";
import type { ReactElement } from "react";
import { cn } from "../lib/utils.ts";

const ITEM_LABEL: Record<ChecklistItem["status"], string> = {
  completed: "done",
  in_progress: "in progress",
  pending: "to do",
};

/**
 * The pinned checklist from `update_plan` (UI design §3.2): one item in progress, distinct from
 * the approved Plan artifact. The in-progress item has a moving 1 px underline (§4.5).
 */
export function Checklist({
  items,
  pinned = false,
}: {
  items: readonly ChecklistItem[];
  pinned?: boolean;
}): ReactElement {
  const done = items.filter((i) => i.status === "completed").length;
  return (
    <ul
      aria-label={`Checklist, ${done} of ${items.length} done`}
      className={cn(
        "my-1 flex flex-wrap gap-x-4 gap-y-1 text-sm",
        pinned && "rounded-lg border border-gray-5 bg-gray-2 px-3 py-2",
      )}
      data-pinned={pinned}
    >
      {items.map((item, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: items have no ids and never reorder
          key={i}
          className={cn(
            "inline-flex items-center gap-1.5",
            item.status === "completed" && "text-muted-foreground",
          )}
        >
          {item.status === "completed" ? (
            <Check className="size-3.5 text-success" aria-hidden="true" />
          ) : item.status === "in_progress" ? (
            <CircleDashed className="size-3.5 text-accent-11" aria-hidden="true" />
          ) : (
            <Circle className="size-3.5 text-gray-8" aria-hidden="true" />
          )}
          <span
            className={cn(
              item.status === "in_progress" &&
                "bg-[linear-gradient(90deg,var(--accent-9)_50%,transparent_50%)] bg-[length:200%_1px] bg-bottom bg-no-repeat pb-px font-medium text-foreground motion-safe:animate-[psy-underline_1.5s_linear_infinite]",
            )}
          >
            {item.text}
          </span>
          <span className="sr-only">({ITEM_LABEL[item.status]})</span>
        </li>
      ))}
    </ul>
  );
}

const STEP_ICON: Record<PlanStep["status"], ReactElement> = {
  done: <Check className="size-3.5 text-success" aria-hidden="true" />,
  running: <CircleDashed className="size-3.5 text-accent-11" aria-hidden="true" />,
  pending: <Circle className="size-3.5 text-gray-8" aria-hidden="true" />,
  failed: <X className="size-3.5 text-danger" aria-hidden="true" />,
  skipped: <Circle className="size-3.5 text-gray-6" aria-hidden="true" />,
};

/** The approved Plan artifact (plan block): numbered steps with status. */
export function PlanCard({
  title,
  steps,
  approvedAt,
  onOpen,
}: {
  title: string;
  steps: readonly PlanStep[];
  approvedAt: string | null;
  onOpen?: () => void;
}): ReactElement {
  return (
    <article
      aria-label={`Plan: ${title}`}
      className="my-2 rounded-lg border border-gray-6 bg-gray-2 p-3 psy-enter"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Plan · {title}</h3>
        <span className="text-xs text-muted-foreground">
          {approvedAt === null ? "Not approved yet" : "Approved"}
        </span>
      </div>
      <ol className="flex flex-col gap-1 text-sm">
        {steps.map((s, i) => (
          <li key={s.id} className="flex items-start gap-2">
            <span className="w-4 text-right text-xs text-muted-foreground tabular-nums">
              {i + 1}
            </span>
            {STEP_ICON[s.status]}
            <span className={cn(s.status === "skipped" && "text-muted-foreground line-through")}>
              {s.title}
              {s.note ? <span className="text-muted-foreground"> — {s.note}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="mt-2 text-sm text-accent-11 hover:underline"
        >
          Open in Plan pane
        </button>
      ) : null}
    </article>
  );
}
