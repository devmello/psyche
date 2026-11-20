import type { MailFollowupAction, MailFollowupItem } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import { usePrefillComposer } from "../chat/prefill.ts";
import { Button } from "../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { ScreenSection } from "../screens/feed/ScreenToolbar.tsx";

const FENCE = "<<<untrusted-data>>>";
const FENCE_END = "<<<end-untrusted-data>>>";

/**
 * The text "Draft a follow-up" fills into the chat composer. Nothing is sent: the prompt asks for
 * a draft, and any send still goes through the usual approval card. The subject and name come
 * from mail, so they are fenced as data and any fence inside them is removed first.
 */
export function followupDraftPrompt(item: MailFollowupItem): string {
  const clean = (s: string) => s.replaceAll(FENCE, "").replaceAll(FENCE_END, "");
  const vars = {
    who: item.who === "" ? t("mailFollowups.someone") : clean(item.who),
    days: item.daysQuiet,
    subject: `${FENCE}${clean(item.subject)}${FENCE_END}`,
  };
  return item.kind === "no_reply"
    ? t("mailFollowups.draft.noReply", vars)
    : t("mailFollowups.draft.question", vars);
}

export function QuietThreadRow({
  item,
  onDraft,
  onAct,
}: {
  item: MailFollowupItem;
  onDraft?: (prompt: string) => void;
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
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onDraft(followupDraftPrompt(item))}
          >
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
  const prefill = usePrefillComposer();
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
            {...(prefill ? { onDraft: prefill } : {})}
            onAct={(action) =>
              call("mailFollowups.act", { id: item.id, action }).finally(() => list.reload())
            }
          />
        ))}
      </ul>
    </ScreenSection>
  );
}
