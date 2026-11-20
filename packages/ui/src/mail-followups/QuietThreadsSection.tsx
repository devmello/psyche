import type { MailFollowupAction, MailFollowupItem } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import { useCall, useGatewayQuery, useStore, useThreads } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { ScreenSection } from "../screens/feed/ScreenToolbar.tsx";
import { useSlots } from "../slots.tsx";

/**
 * "Draft a follow-up": a new side chat with the thread as the composer's context chip and a fixed
 * sentence of the owner's own in the composer. None of the email's words (the sender's name, the
 * subject) go into the message: the Gateway reads the thread by id on send, fences it and starts
 * the turn tainted. Nothing is sent. Undefined where no chat can be opened (a detached window).
 */
export function useDraftFollowup(): ((item: MailFollowupItem) => void) | undefined {
  const store = useStore();
  const threads = useThreads();
  const { navigate } = useSlots();
  if (!navigate || store.detached) return undefined;
  return (item) => {
    threads
      .create({ kind: "side", title: t("mailFollowups.thread.title") })
      .then((thread) => {
        store.update((s) => ({
          ...s,
          composerPrefill: t("mailFollowups.prefill"),
          composerContext: {
            threadId: thread.id,
            ref: { kind: "mail_followup", id: item.id },
            title: item.subject.slice(0, 300),
            source: item.who === "" ? null : item.who.slice(0, 200),
            url: null,
          },
        }));
        navigate(`/chat/${thread.id}`);
      })
      .catch((err: unknown) => {
        toast(t("mailFollowups.failed", { reason: describeError(err) }));
      });
  };
}

export function QuietThreadRow({
  item,
  onDraft,
  onAct,
}: {
  item: MailFollowupItem;
  onDraft?: () => void;
  onAct: (action: MailFollowupAction) => Promise<unknown>;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const who = item.who === "" ? t("mailFollowups.someone") : item.who;
  const run = async (action: MailFollowupAction) => {
    setBusy(true);
    try {
      await onAct(action);
    } catch (err) {
      toast(t("mailFollowups.failed", { reason: describeError(err) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      className="relative flex flex-col gap-2 px-2.5 py-2.5 before:absolute before:inset-x-2.5 before:top-0 before:h-px before:bg-separator first:before:hidden"
      data-testid="quiet-thread"
    >
      <div className="flex flex-col gap-0.5">
        <p className="text-body text-label-primary">
          {item.kind === "no_reply"
            ? t("mailFollowups.line.noReply", { who, days: item.daysQuiet })
            : t("mailFollowups.line.question", { who, days: item.daysQuiet })}
        </p>
        <p
          className="truncate text-callout text-label-secondary"
          data-testid="quiet-thread-subject"
        >
          {item.subject}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onDraft ? (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onDraft}>
            {t("mailFollowups.draft")}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void run("snooze")}
        >
          {t("mailFollowups.snooze")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void run("dismiss")}
        >
          {t("mailFollowups.dismiss")}
        </Button>
      </div>
    </li>
  );
}

const SHOWN = 3;

/**
 * Email threads gone quiet: the owner sent the last message and got no reply, or never answered a
 * question. Nothing while the setting is off, no mail is connected, or nothing is quiet.
 */
export function QuietThreadsSection({ limit = SHOWN }: { limit?: number }): ReactElement | null {
  const call = useCall();
  const list = useGatewayQuery("mailFollowups.list", {});
  const draft = useDraftFollowup();
  const items = list.data?.enabled ? list.data.items.slice(0, limit) : [];
  if (items.length === 0) return null;
  return (
    <ScreenSection
      id="quiet-threads"
      title={t("home.quietThreads")}
      large
      description={t("home.quietThreads.hint")}
    >
      <ul
        aria-label={t("home.quietThreads")}
        className="flex flex-col rounded-lg bg-surface-raised p-1 shadow-elevation-1"
      >
        {items.map((item) => (
          <QuietThreadRow
            key={item.id}
            item={item}
            {...(draft ? { onDraft: () => draft(item) } : {})}
            onAct={(action) =>
              call("mailFollowups.act", { id: item.id, action }).finally(() => list.reload())
            }
          />
        ))}
      </ul>
    </ScreenSection>
  );
}
