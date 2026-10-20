import { ShieldCheck } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { ApprovalCard, FOCUS_APPROVAL_EVENT } from "../blocks/ApprovalCard.tsx";
import { useApprovals, useStoreState } from "../data/index.ts";
import { displaySummary } from "../lib/cards.ts";
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
  useEffect(() => {
    const onFocus = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      setOpenId(id);
      // Already open: the card stays mounted, so move focus to its heading here.
      document.querySelector<HTMLElement>(`[data-approval-id="${CSS.escape(id)}"] h3`)?.focus();
    };
    window.addEventListener(FOCUS_APPROVAL_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_APPROVAL_EVENT, onFocus);
  }, []);
  const mine = pending
    .filter((v) => v.approval.requestedBy.threadId === threadId)
    .sort((a, b) => a.approval.expiresAt.localeCompare(b.approval.expiresAt));
  const open = mine.find((v) => v.approval.id === openId) ?? mine[0];
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      // Compact (§3.3): one open card, the rest one line each. The card is never clipped (its
      // choices and buttons stay in view); its binding rows scroll instead when they run long.
      className="flex flex-col gap-1.5"
    >
      {mine.length > 0 ? (
        <p className="sr-only">
          {mine.length === 1 ? "1 approval needs you" : `${mine.length} approvals need you`}
        </p>
      ) : null}
      {mine.length > 1 ? (
        <ul aria-label="Other approvals" className="flex max-h-24 flex-col gap-1 overflow-y-auto">
          {mine
            .filter((v) => v !== open)
            .map((v) => (
              <li key={v.approval.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(v.approval.id)}
                  className="elevation-1 flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-small transition-colors hover:bg-gray-3"
                >
                  <ShieldCheck className="size-4 text-approval-text" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{displaySummary(v.approval)}</span>
                  <span
                    className={cn(
                      "text-caption tabular-nums",
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
                detailsClassName="max-h-[min(9rem,18vh)] overflow-y-auto"
              />
            );
          })()
        : null}
    </div>
  );
}
