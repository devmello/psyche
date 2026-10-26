import type { ChecklistItem, PlanStep } from "@psyche/protocol";
import { Check, Circle, CircleDashed, X } from "lucide-react";
import { useReducedMotionConfig } from "motion/react";
import * as m from "motion/react-m";
import type { ReactElement } from "react";
import { Badge } from "../components/ui/badge.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { duration, ease } from "../motion/index.ts";
import { Card } from "./card.tsx";

const itemLabel = (status: ChecklistItem["status"]): string => t(`blocks.checklist.item.${status}`);

/**
 * A 16 px circle that fills when the item completes, with a check that draws (redesign-2026
 * §5.2). Only a change draws: items already done when the list mounts appear done. Under reduced
 * motion the check appears at once.
 */
function ItemMark({ status }: { status: ChecklistItem["status"] }): ReactElement {
  const reduce = useReducedMotionConfig();
  const done = status === "completed";
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="7"
        className={cn(
          "transition-[fill,stroke] duration-(--duration-micro) ease-(--ease-standard)",
          done
            ? "fill-success stroke-success"
            : status === "in_progress"
              ? "fill-transparent stroke-accent-9"
              : "fill-transparent stroke-label-quaternary",
        )}
        strokeWidth="1.5"
        strokeDasharray={status === "in_progress" ? "3 2" : undefined}
      />
      <m.path
        d="M5 8.2 7.1 10.3 11 6"
        fill="none"
        stroke="white"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={false}
        animate={{ pathLength: done ? 1 : 0, opacity: done ? 1 : 0 }}
        transition={{ duration: reduce ? 0 : (duration.micro * 2) / 1000, ease: [...ease.enter] }}
      />
    </svg>
  );
}

/**
 * The pinned checklist from `update_plan` (UI design §3.2): one item in progress, distinct from
 * the approved Plan artifact. The in-progress item reads label-primary, the rest secondary.
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
      aria-label={t("blocks.checklist.label", { done, total: items.length })}
      className={cn(
        "my-2 flex flex-col gap-1.5 text-body",
        pinned && "rounded-lg bg-surface-raised px-4 py-3 shadow-elevation-1",
      )}
      data-pinned={pinned}
    >
      {items.map((item, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: items have no ids and never reorder
          key={i}
          className={cn(
            "flex items-center gap-2",
            item.status === "in_progress" ? "text-label-primary" : "text-label-secondary",
          )}
        >
          <ItemMark status={item.status} />
          <span>{item.text}</span>
          <span className="sr-only">
            {t("blocks.checklist.itemStatus", { status: itemLabel(item.status) })}
          </span>
        </li>
      ))}
    </ul>
  );
}

const STEP_ICON: Record<PlanStep["status"], ReactElement> = {
  done: <Check className="size-3.5 text-success" aria-hidden="true" />,
  running: <CircleDashed className="size-3.5 text-accent-11" aria-hidden="true" />,
  pending: <Circle className="size-3.5 text-gray-9" aria-hidden="true" />,
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
    <Card
      label={t("blocks.plan.label", { title })}
      title={t("blocks.plan.title", { title })}
      meta={
        approvedAt === null ? (
          <Badge variant="approval">{t("blocks.plan.notApproved")}</Badge>
        ) : (
          <Badge variant="success">
            <Check aria-hidden="true" /> {t("blocks.plan.approved")}
          </Badge>
        )
      }
      actions={
        onOpen
          ? [
              {
                id: "open",
                label: t("blocks.plan.open"),
                kind: "open",
                primary: true,
                onSelect: onOpen,
              },
            ]
          : []
      }
    >
      <ol className="mt-1 flex flex-col gap-1 text-body">
        {steps.map((s, i) => (
          <li key={s.id} className="flex items-start gap-2">
            <span className="w-4 text-end text-callout text-label-secondary tabular-nums">
              {i + 1}
            </span>
            {STEP_ICON[s.status]}
            <span className={cn(s.status === "skipped" && "text-label-secondary line-through")}>
              {s.title}
              {s.note ? <span className="text-label-secondary"> — {s.note}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
