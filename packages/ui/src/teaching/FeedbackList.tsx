import type { FeedbackEvent } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { EmptyState, ErrorState } from "../components/page.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/ui/alert-dialog.tsx";
import { Button } from "../components/ui/button.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { useGatewayQuery } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { formatDate } from "../lib/format.ts";
import { useTeaching } from "./hooks.ts";

/**
 * The owner's feedback, newest first (teaching loop §5.3): what they gave on an answer or an
 * action, in plain words, with "Show older" paging and a Delete per row. Deleting drops only that
 * feedback; lessons made solely from it are forgotten (the confirm says so).
 */

export const FEEDBACK_PAGE = 20;

/** "Thumbs down · Reply": what the owner gave and what it was about. */
export function feedbackRowText(e: FeedbackEvent): string {
  return t("screens.feedback.row", {
    kind: t(`screens.feedback.kind.${e.kind}`),
    target: t(`screens.feedback.target.${e.target.type}`),
  });
}

export function FeedbackList(): ReactElement {
  const teach = useTeaching();
  const q = useGatewayQuery("feedback.list", { limit: FEEDBACK_PAGE });
  // Older pages loaded by "Show older". `tail` is the cursor after the last loaded page
  // (undefined until one is loaded, then the first page's cursor is used).
  const [older, setOlder] = useState<FeedbackEvent[]>([]);
  const [tail, setTail] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const first = q.data?.events ?? [];
  const nextCursor = tail !== undefined ? tail : (q.data?.nextCursor ?? null);
  const events = [...first, ...older];

  const loadOlder = async () => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await teach.listFeedback({ cursor: nextCursor, limit: FEEDBACK_PAGE });
      setOlder((prev) => [...prev, ...page.events]);
      setTail(page.nextCursor ?? null);
    } catch (e) {
      setMoreError(errorText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const remove = async (eventId: string) => {
    setDeleteError(null);
    try {
      await teach.deleteFeedback(eventId);
      // Paged rows shift after a delete, so drop them and start again from the newest page.
      setOlder([]);
      setTail(undefined);
    } catch (e) {
      setDeleteError(errorText(e));
    }
  };

  if (q.data === undefined) {
    return (
      <section aria-label={t("screens.feedback.title")} data-testid="feedback-list">
        <h3 className="mb-1 text-headline text-label-primary">{t("screens.feedback.title")}</h3>
        {q.error ? (
          <ErrorState
            what={t("screens.feedback.loadFailed")}
            reason={q.error}
            retry={{ onClick: q.reload }}
          />
        ) : (
          <Skeleton className="h-12" />
        )}
      </section>
    );
  }

  return (
    <section aria-label={t("screens.feedback.title")} data-testid="feedback-list">
      <h3 className="mb-1 text-headline text-label-primary">{t("screens.feedback.title")}</h3>
      {deleteError ? (
        <ErrorState what={t("screens.feedback.deleteFailed")} reason={deleteError} />
      ) : null}
      {events.length === 0 ? (
        <EmptyState>{t("screens.feedback.empty")}</EmptyState>
      ) : (
        <ul className="divide-y divide-separator">
          {events.map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-2" data-testid="feedback-row">
              <time
                dateTime={e.createdAt}
                className="w-14 shrink-0 text-callout text-label-secondary tabular-nums"
              >
                {formatDate(e.createdAt)}
              </time>
              <span className="min-w-0 flex-1 text-body text-label-primary">
                {feedbackRowText(e)}
              </span>
              <AlertDialog>
                <AlertDialogTrigger
                  render={
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("screens.feedback.deleteLabel", {
                        date: formatDate(e.createdAt),
                      })}
                    />
                  }
                >
                  {t("common.delete")}
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("screens.feedback.deleteTitle")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("screens.feedback.deleteBody")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => void remove(e.id)}>
                      {t("common.delete")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </li>
          ))}
        </ul>
      )}
      {moreError ? <ErrorState what={t("screens.feedback.loadFailed")} reason={moreError} /> : null}
      {nextCursor !== null ? (
        <div className="mt-2">
          <Button size="sm" variant="ghost" disabled={loadingMore} onClick={() => void loadOlder()}>
            {t("screens.feedback.showOlder")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function errorText(e: unknown): string {
  return describeError(e);
}
