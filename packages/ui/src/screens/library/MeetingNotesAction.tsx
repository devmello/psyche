import type { LibraryItem, MeetingNotesResult } from "@psyche/protocol";
import { Loader2 } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { useSlots } from "../../slots.tsx";

/**
 * "Make meeting notes" on an audio or video Library item (`meetings.notes.create`). The Mac
 * transcribes the file (up to 4 h) and writes one meeting_notes Feed post. The method has no
 * progress events for a Library item, so "running" is shown until the call returns. A refusal
 * (including `needs_permission`, whose question the Gateway writes) shows its text and Retry.
 */

/** Only audio and video items can become meeting notes. */
export function isMeetingMedia(item: Pick<LibraryItem, "kind">): boolean {
  return item.kind === "audio" || item.kind === "video";
}

type Phase =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; postId: string | null }
  | { status: "failed"; reason: string };

export function MeetingNotesAction({ item }: { item: LibraryItem }): ReactElement | null {
  const call = useCall();
  const { navigate } = useSlots();
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  if (!isMeetingMedia(item)) return null;

  const run = () => {
    setPhase({ status: "running" });
    call("meetings.notes.create", { libraryItemId: item.id }).then(
      (result: MeetingNotesResult) => {
        if (!live.current) return;
        if (result.status === "done") {
          setPhase({ status: "done", postId: result.postId ?? null });
        } else {
          setPhase({
            status: "failed",
            reason: result.question ?? t("errors.unknown"),
          });
        }
      },
      (err: unknown) => {
        if (live.current) setPhase({ status: "failed", reason: describeError(err) });
      },
    );
  };

  if (phase.status === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-callout">
        <p role="alert" className="min-w-0 flex-1 text-danger-text">
          {t("screens.library.meetingNotes.failed", { reason: phase.reason })}
        </p>
        <Button type="button" size="xs" variant="outline" onClick={run}>
          {t("common.tryAgain")}
        </Button>
      </div>
    );
  }

  if (phase.status === "running") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-callout">
        <Button type="button" size="xs" variant="outline" disabled>
          <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />
          {t("screens.library.meetingNotes.action")}
        </Button>
        <p role="status" className="min-w-0 flex-1 text-label-secondary">
          {t("screens.library.meetingNotes.running")}
        </p>
      </div>
    );
  }

  if (phase.status === "done") {
    const postId = phase.postId;
    return (
      <div className="flex flex-wrap items-center gap-2 text-callout">
        <p role="status" className="min-w-0 flex-1 text-label-secondary">
          {t("screens.library.meetingNotes.done")}
        </p>
        {postId !== null && navigate ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => navigate(`/home?post=${encodeURIComponent(postId)}`)}
          >
            {t("screens.library.meetingNotes.open")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-callout">
      <Button type="button" size="xs" variant="outline" onClick={run}>
        {t("screens.library.meetingNotes.action")}
      </Button>
    </div>
  );
}
