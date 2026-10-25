import { ShieldCheck } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { ApprovalCard, FOCUS_APPROVAL_EVENT } from "../blocks/ApprovalCard.tsx";
import { useApprovals, useStoreState } from "../data/index.ts";
import { t } from "../i18n/core.ts";
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
  // The open card stays put: a new approval that expires sooner joins the rows instead of
  // replacing the card under the owner's focus (docs/a11y-audit.md C2).
  const ids = mine.map((v) => v.approval.id).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the pending ids
  useEffect(() => {
    if (openId === null || !mine.some((v) => v.approval.id === openId)) {
      setOpenId(mine[0]?.approval.id ?? null);
    }
  }, [ids]);
  const open = mine.find((v) => v.approval.id === openId) ?? mine[0];
  const newest = [...mine].sort((a, b) =>
    b.approval.requestedAt.localeCompare(a.approval.requestedAt),
  )[0];
  return (
    <div
      // Compact (§3.3): one open card, the rest one line each. The card is never clipped (its
      // choices and buttons stay in view); its binding rows scroll instead when they run long.
      className="flex flex-col gap-1.5"
      data-testid="approval-dock"
    >
      {/* One short line per arrival, not the whole card (docs/a11y-audit.md C4). */}
      <p className="sr-only" role="status">
        {mine.length === 0
          ? ""
          : t("chat.approvals.announce", {
              summary: newest ? displaySummary(newest.approval) : "",
              count: mine.length,
            })}
      </p>
      {mine.length > 1 ? (
        <ul
          aria-label={t("chat.approvals.others")}
          className="flex max-h-24 flex-col gap-1 overflow-y-auto"
        >
          {mine
            .filter((v) => v !== open)
            .map((v) => (
              <li key={v.approval.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(v.approval.id)}
                  className="elevation-1 flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-start text-small transition-colors hover:bg-gray-3"
                >
                  <ShieldCheck className="size-4 text-approval-text" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{displaySummary(v.approval)}</span>
                  <span
                    className={cn(
                      "text-callout tabular-nums",
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
                onAnswer={async (decision, scope) => {
                  await answer(open.approval.id, decision, scope);
                  // The next card focuses its heading as it mounts; with none left, focus returns
                  // to the composer instead of falling to the page (docs/a11y-audit.md C3).
                  if (mine.length <= 1) {
                    document
                      .querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")
                      ?.focus();
                  }
                }}
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
