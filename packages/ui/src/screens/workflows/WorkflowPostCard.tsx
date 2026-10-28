import type { DigestAction, DigestItem, DigestLoop, FeedPost } from "@psyche/protocol";
import type { ReactElement, ReactNode } from "react";
import { toast } from "sonner";
import { usePrefillComposer } from "../../chat/prefill.ts";
import { useStore } from "../../data/provider.tsx";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { useOpenLink } from "../../links/LinkPrompt.tsx";
import { useSlots } from "../../slots.tsx";
import { ProposalBatchCard } from "./BatchCard.tsx";
import { DailyCard } from "./DailyCard.tsx";
import { DigestCard, type DigestLoopAction } from "./DigestCard.tsx";
import { MeetingNotesCard } from "./MeetingNotesCard.tsx";
import { MeetingPrepCard } from "./MeetingPrepCard.tsx";
import { senderName } from "./shared.tsx";

/** The shell's "Record meeting" request; its consent dialog opens on it. */
export const RECORD_MEETING_EVENT = "psyche:record-meeting";

export interface WorkflowPostCardProps {
  post: FeedPost & { card: NonNullable<FeedPost["card"]> };
  /** The focused card holds the one accent primary (redesign-2026 §5.6). */
  focused?: boolean;
  /** The inline batch card for a proposal (§7.2); absent → the Gateway-backed one. */
  renderBatch?: (proposalId: string, close: () => void) => ReactNode;
  now?: number;
  className?: string;
}

/**
 * The Feed's hook for workflow posts (docs/workflows/mail-and-meetings-2026.md §8.5): a post with
 * a structured `card` renders as its digest, meeting prep or meeting notes card. Actions that
 * need the agent (draft a reply, propose times, a nudge, a recap) fill the composer with the
 * owner's request; Snooze and Done update the memory graph's loop; links open outside the app.
 */
export function WorkflowPostCard({
  post,
  focused = false,
  renderBatch,
  now,
  className,
}: WorkflowPostCardProps): ReactElement {
  const store = useStore();
  const { navigate } = useSlots();
  const openLink = useOpenLink();
  const prefill = usePrefillComposer();
  const card = post.card;
  const batch = renderBatch ?? ((id: string) => <ProposalBatchCard proposalId={id} />);
  const common = {
    ...(now === undefined ? {} : { now }),
    ...(className ? { className } : {}),
  };

  const onItem = (item: DigestItem, action: DigestAction) => {
    const link = item.thread.link;
    if (action === "open") {
      if (link) openLink(link);
      return;
    }
    prefill?.(
      t(`workflows.ask.${action}`, {
        sender: senderName(item.thread.from),
        subject: item.thread.subject ?? item.summary,
      }),
    );
  };
  const onLoop = (loop: DigestLoop, action: DigestLoopAction) => {
    if (action === "nudge") {
      prefill?.(
        t("workflows.ask.nudge", {
          name: loop.counterpart ?? t("workflows.digest.someone"),
          text: loop.loop.text,
        }),
      );
      return;
    }
    store
      .call("memory.loops.update", {
        id: loop.loop.id,
        status: action === "done" ? "done" : "snoozed",
      })
      .catch((err: unknown) => toast.error(describeError(err)));
  };

  switch (card.type) {
    case "digest":
      return (
        <DigestCard
          digest={card.digest}
          onAction={onItem}
          onLoop={onLoop}
          renderBatch={batch}
          {...(navigate ? { onSettings: () => navigate("/settings/mail") } : {})}
          {...common}
        />
      );
    case "daily":
      return (
        <DailyCard
          brief={card.daily}
          focused={focused}
          onOpen={(link) => (link.startsWith("/") ? navigate?.(link) : openLink(link))}
          onFollowup={(id, action) => {
            store
              .call("daily.followups.update", { id, action })
              .catch((err: unknown) => toast.error(describeError(err)));
          }}
          onCarryOver={(ids) => {
            store
              .call("daily.carryOver", { ids })
              .then(() => toast.success(t("daily.carryOver.done")))
              .catch((err: unknown) => toast.error(describeError(err)));
          }}
          {...(className ? { className } : {})}
        />
      );
    case "meeting_prep":
      return (
        <MeetingPrepCard
          prep={card.prep}
          focused={focused}
          // The shell's consent dialog listens for this event (apps/web MeetingRecord).
          onRecord={(meetingId) =>
            document.dispatchEvent(new CustomEvent(RECORD_MEETING_EVENT, { detail: { meetingId } }))
          }
          onJoin={(url: string) => openLink(url)}
          onSource={(s) => {
            if (s.kind === "url" || /^https?:/i.test(s.ref)) openLink(s.ref);
          }}
          {...common}
        />
      );
    case "meeting_notes":
      return (
        <MeetingNotesCard
          notes={card.notes}
          focused={focused}
          renderBatch={batch}
          {...(prefill
            ? { onDraftRecap: () => prefill(t("workflows.ask.recap", { title: card.notes.title })) }
            : {})}
          {...(className ? { className } : {})}
        />
      );
  }
}
