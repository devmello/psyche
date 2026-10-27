import { ShieldCheck } from "lucide-react";
import * as m from "motion/react-m";
import { type ReactElement, useEffect, useState } from "react";
import { ApprovalCard, FOCUS_APPROVAL_EVENT } from "../blocks/ApprovalCard.tsx";
import { useApprovals, useStoreState } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { displaySummary } from "../lib/cards.ts";
import { formatCountdown } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { cn } from "../lib/utils.ts";
import { fade, Presence } from "../motion/index.ts";
import { usePersona } from "../slots.tsx";

/**
 * The approval dock above the composer (UI design §3.3, redesign-2026 §5.3): pending approvals
 * for this thread, outside the message stream. One card is open at a time (the most urgent
 * first); the others stack as a deck behind it, and "N more" brings the next one forward. When
 * a card is answered it morphs (`layoutId`) into its one-line result row in the transcript. A new card takes
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
  const threads = useStoreState((s) => s.threads);
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
  const others = mine.filter((v) => v !== open);
  const next = others[0];
  const edges = Math.min(others.length, 2);
  return (
    <div className="flex flex-col gap-1.5" data-testid="approval-dock">
      {/* One short line per arrival, not the whole card (docs/a11y-audit.md C4). */}
      <p className="sr-only" role="status">
        {mine.length === 0
          ? ""
          : t("chat.approvals.announce", {
              summary: newest ? displaySummary(newest.approval) : "",
              count: mine.length,
            })}
      </p>
      {open ? (
        // A deck (redesign-2026 §5.3): the most urgent card in full, the others as 8 px edges
        // peeking below it. The card is never clipped; its binding rows scroll when they run long.
        // `layout="position"` lets what follows the deck slide to its place when an edge arrives or
        // leaves (the padding steps by 6 px), instead of jumping.
        <m.div
          layout="position"
          className="relative"
          style={{ paddingBottom: edges * 6 }}
          data-testid="approval-deck"
        >
          <Presence initial={false}>
            {Array.from({ length: edges }, (_, i) => (
              <m.span
                // biome-ignore lint/suspicious/noArrayIndexKey: decorative layers, fixed order
                key={i}
                aria-hidden="true"
                className="absolute h-10 rounded-b-lg bg-surface-raised shadow-elevation-1"
                style={{ insetInline: (edges - i) * 10, bottom: i * 6 }}
                {...fade}
              />
            ))}
          </Presence>
          <Presence mode="popLayout" initial={false}>
            {(() => {
              const taskId = open.approval.requestedBy.taskId;
              const task = taskId ? tasks[taskId] : undefined;
              return (
                <ApprovalCard
                  key={open.approval.id}
                  layoutId={`approval-${open.approval.id}`}
                  approval={open.approval}
                  canAnswer={open.canAnswer}
                  stale={open.stale}
                  persona={persona.name}
                  taskTitle={task?.title ?? null}
                  createdFrom={task?.createdFrom ?? null}
                  parentThreadTitle={
                    task?.specialist
                      ? (threads[task.specialist.parentThreadId]?.thread.title ?? null)
                      : null
                  }
                  {...(mode === undefined ? {} : { mode })}
                  otherSurfaces={open.approval.surfaces.filter(
                    (s) => s !== "desktop" && s !== "web",
                  )}
                  onAnswer={async (decision, scope, extras) => {
                    await answer(open.approval.id, decision, scope, extras);
                    // The next card focuses its heading as it mounts; with none left, focus
                    // returns to the composer instead of falling to the page (a11y-audit C3).
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
            })()}
          </Presence>
        </m.div>
      ) : null}
      <Presence initial={false}>
        {next ? (
          <m.div key="more" layout="position" className="flex justify-center" {...fade}>
            {/* "2 more": shows the next card (most urgent first); its name says which one. */}
            <button
              type="button"
              onClick={() => setOpenId(next.approval.id)}
              className="inline-flex h-6 cursor-default items-center gap-1.5 self-center rounded-full px-2.5 text-callout text-label-secondary outline-none transition-colors duration-(--duration-micro) ease-(--ease-standard) hover:bg-fill-tertiary hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("chat.approval.nextLabel", {
                more: t("chat.approval.others", { n: others.length }),
                summary: displaySummary(next.approval),
                countdown: formatCountdown(Date.parse(next.approval.expiresAt) - now),
              })}
            >
              <ShieldCheck className="size-3.5 text-approval-text" aria-hidden="true" />
              {t("chat.approval.others", { n: others.length })}
              <span
                className={cn(
                  "tabular-nums",
                  Date.parse(next.approval.expiresAt) - now < 60_000
                    ? "text-danger-text"
                    : "text-label-tertiary",
                )}
              >
                · {formatCountdown(Date.parse(next.approval.expiresAt) - now)}
              </span>
            </button>
          </m.div>
        ) : null}
      </Presence>
    </div>
  );
}
