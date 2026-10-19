import { ShieldCheck } from "lucide-react";
import { type ReactElement, useState } from "react";
import { ApprovalCard } from "../blocks/ApprovalCard.tsx";
import { useApprovals, useStoreState } from "../data/index.ts";
import { formatCountdown } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { cn } from "../lib/utils.ts";
import { usePersona } from "../slots.tsx";

/**
 * The approval dock above the composer (UI design §3.3): pending approvals for this thread,
 * outside the message stream. One card is open at a time (the most urgent first) so the
 * transcript stays visible; the others are one-line rows that open on click. A new card takes
 * focus unless the user is typing and is announced through a polite live region (§4.11).
 */
export function ApprovalDock({
  threadId,
  mode,
  now: fixedNow,
}: {
  threadId: string;
  mode?: string;
  now?: number;
}): ReactElement | null {
  const now = useNow(1000, fixedNow);
  const { pending, answer } = useApprovals();
  const persona = usePersona();
  const tasks = useStoreState((s) => s.tasks);
  const [openId, setOpenId] = useState<string | null>(null);
  const mine = pending
    .filter((v) => v.approval.requestedBy.threadId === threadId)
    .sort((a, b) => a.approval.expiresAt.localeCompare(b.approval.expiresAt));
  const open = mine.find((v) => v.approval.id === openId) ?? mine[0];
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto"
    >
      {mine.length > 0 ? (
        <p className="sr-only">
          {mine.length === 1 ? "1 approval needs you" : `${mine.length} approvals need you`}
        </p>
      ) : null}
      {mine.length > 1 ? (
        <ul aria-label="Other approvals" className="flex flex-col gap-1">
          {mine
            .filter((v) => v !== open)
            .map((v) => (
              <li key={v.approval.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(v.approval.id)}
                  className="flex w-full items-center gap-2 rounded-lg border border-approval-border bg-approval-surface px-3 py-1.5 text-left text-sm hover:bg-amber-3"
                >
                  <ShieldCheck className="size-3.5 text-approval-text" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{v.approval.summary}</span>
                  <span
                    className={cn(
                      "text-xs tabular-nums",
                      Date.parse(v.approval.expiresAt) - now < 60_000
                        ? "text-danger-text"
                        : "text-muted-foreground",
                    )}
                  >
                    {formatCountdown(Date.parse(v.approval.expiresAt) - now)}
                  </span>
                </button>
              </li>
            ))}
        </ul>
      ) : null}
      {open
        ? (() => {
            const taskId = open.approval.requestedBy.taskId;
            const task = taskId ? tasks[taskId] : undefined;
            return (
              <ApprovalCard
                key={open.approval.id}
                approval={open.approval}
                canAnswer={open.canAnswer}
                stale={open.stale}
                persona={persona.name}
                taskTitle={task?.title ?? null}
                createdFrom={task?.createdFrom ?? null}
                {...(mode === undefined ? {} : { mode })}
                otherSurfaces={open.approval.surfaces.filter((s) => s !== "desktop" && s !== "web")}
                onAnswer={(decision, scope) => answer(open.approval.id, decision, scope)}
                autoFocus
                now={now}
              />
            );
          })()
        : null}
    </div>
  );
}
