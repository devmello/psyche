import type {
  DigestAction,
  DigestGroup,
  DigestItem,
  DigestLoop,
  InboxDigest,
} from "@psyche/protocol";
import { ShieldQuestion } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { formatTime } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import {
  CardSection,
  CloudChip,
  daysBetween,
  REVEAL,
  ROW,
  RowMenu,
  senderName,
  TaintChip,
  WorkflowCardFrame,
} from "./shared.tsx";

export type DigestLoopAction = "nudge" | "snooze" | "done";

export interface DigestCardProps {
  digest: InboxDigest;
  /** Fixed clock (stories, tests). */
  now?: number;
  /** A per-row action under ⋯, or a screen row's Allow / Not now / Always archive. */
  onAction?: (item: DigestItem, action: DigestAction) => void;
  /** A Waiting on row's Draft a nudge, Snooze or Done. */
  onLoop?: (loop: DigestLoop, action: DigestLoopAction) => void;
  /**
   * The group row's "Do it": the batch card opens inline under the row (§7.2). Without it the
   * button calls `onGroup`.
   */
  renderBatch?: (proposalId: string, close: () => void) => ReactNode;
  onGroup?: (group: DigestGroup) => void;
  onSettings?: () => void;
  className?: string;
}

/** The actions a row's ⋯ offers, in the order of §7.1. */
const ROW_ACTIONS: readonly DigestAction[] = [
  "draft_reply",
  "remind",
  "propose_times",
  "save_attachment",
  "mark_read",
  "archive",
  "move",
  "open",
];
const SCREEN_ACTIONS: readonly DigestAction[] = ["allow_sender", "not_now", "always_archive"];

const actionLabel = (a: DigestAction): string => t(`workflows.digest.action.${a}`);

function ItemRow({
  item,
  onAction,
  inline,
}: {
  item: DigestItem;
  onAction?: DigestCardProps["onAction"];
  /** Actions shown as buttons instead of under ⋯ (the screen rows). */
  inline?: readonly DigestAction[];
}): ReactElement {
  const subject = item.thread.subject ?? item.summary;
  const menu = ROW_ACTIONS.filter((a) => item.actions.includes(a)).map((a) => ({
    id: a,
    label: actionLabel(a),
    onSelect: () => onAction?.(item, a),
  }));
  const buttons = (inline ?? []).filter((a) => item.actions.includes(a));
  return (
    <li className={ROW}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="min-w-0 text-body text-label-primary">
          <span className="font-medium">{senderName(item.thread.from)}</span>
          <span className="text-label-secondary"> · </span>
          {item.summary}
        </p>
        {item.because ? (
          <p className="text-callout text-label-secondary">
            {t("workflows.digest.because", { reason: item.because })}
          </p>
        ) : null}
        {buttons.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {buttons.map((a) => (
              <Button
                key={a}
                type="button"
                size="xs"
                variant={a === "allow_sender" ? "secondary" : "ghost"}
                onClick={() => onAction?.(item, a)}
              >
                {actionLabel(a)}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      {inline === undefined ? (
        <RowMenu label={t("workflows.more", { subject })} items={menu} />
      ) : null}
    </li>
  );
}

function GroupRow({
  group,
  open,
  onDoIt,
  batch,
}: {
  group: DigestGroup;
  open: boolean;
  onDoIt?: () => void;
  batch: ReactNode;
}): ReactElement {
  return (
    <li className={cn(ROW, "flex-col items-stretch")}>
      <div className="flex min-w-0 items-center gap-3">
        <p className="min-w-0 flex-1 text-body text-label-primary">{group.title}</p>
        {group.proposalId !== null && onDoIt ? (
          <Button type="button" size="sm" variant="secondary" aria-expanded={open} onClick={onDoIt}>
            {t("workflows.digest.doIt")}
          </Button>
        ) : null}
      </div>
      {open ? <div className="mt-2">{batch}</div> : null}
    </li>
  );
}

function LoopRow({
  loop,
  now,
  onLoop,
}: {
  loop: DigestLoop;
  now: number;
  onLoop?: DigestCardProps["onLoop"];
}): ReactElement {
  const since = loop.thread?.at ?? loop.loop.createdAt;
  const parts = [
    loop.counterpart ?? t("workflows.digest.someone"),
    loop.loop.text,
    t("time.days", { n: daysBetween(since, now) }),
  ];
  return (
    <li className={cn(ROW, "flex-wrap items-center")}>
      <p className="min-w-0 flex-1 text-body text-label-primary">{parts.join(" · ")}</p>
      <div className={cn("flex gap-1", onLoop ? REVEAL : "hidden")}>
        <Button type="button" size="xs" variant="ghost" onClick={() => onLoop?.(loop, "nudge")}>
          {t("workflows.digest.nudge")}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => onLoop?.(loop, "snooze")}>
          {t("workflows.digest.snooze")}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => onLoop?.(loop, "done")}>
          {t("workflows.digest.done")}
        </Button>
      </div>
    </li>
  );
}

/**
 * The daily inbox digest (docs/workflows/mail-and-meetings-2026.md §7.1, §4.1): the briefing
 * hero. Needs you rows with the "Because:" phrase and their actions under ⋯; one group row per
 * bulk category whose "Do it" opens its batch card inline; Waiting on rows from the memory
 * graph's loops; first-time senders to screen; senders that failed verification; and "Updated
 * 7:30 · Settings". Mail text is untrusted data and renders as plain text.
 */
export function DigestCard({
  digest,
  now = Date.now(),
  onAction,
  onLoop,
  renderBatch,
  onGroup,
  onSettings,
  className,
}: DigestCardProps): ReactElement {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const time = formatTime(digest.createdAt);
  const sorted = Object.values(digest.counts).reduce((a, b) => a + b, 0);
  const quiet =
    digest.needsYou.length === 0 &&
    digest.groups.length === 0 &&
    digest.waitingOn.length === 0 &&
    digest.screen.length === 0 &&
    digest.unverified.length === 0;
  const firstSender = digest.needsYou[0]?.thread.from;

  return (
    <WorkflowCardFrame
      data-kind="digest"
      hero
      label={t("workflows.digest.label")}
      kind={`${t("workflows.kind.digest")} · ${t("workflows.digest.header", {
        time,
        n: digest.needsYou.length,
      })}`}
      chips={
        <>
          {digest.taint && !quiet ? (
            <TaintChip {...(firstSender ? { from: senderName(firstSender) } : {})} />
          ) : null}
          {digest.usedCloudModel ? <CloudChip /> : null}
        </>
      }
      footer={
        <>
          <span>{t("workflows.digest.updated", { time })}</span>
          {onSettings ? (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={onSettings}
                className="cursor-default rounded-xs text-callout text-label-secondary hover:text-label-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {t("workflows.digest.settings")}
              </button>
            </>
          ) : null}
        </>
      }
      {...(className ? { className } : {})}
    >
      {quiet ? (
        <p className="text-reading text-label-primary">
          {t("workflows.digest.quiet", { n: sorted })}
        </p>
      ) : null}

      {digest.needsYou.length > 0 ? (
        <CardSection title={t("workflows.digest.needsYou")}>
          <ul>
            {digest.needsYou.map((item) => (
              <ItemRow
                key={`${item.thread.account}:${item.thread.threadId}`}
                item={item}
                {...(onAction ? { onAction } : {})}
              />
            ))}
          </ul>
        </CardSection>
      ) : null}

      {digest.groups.length > 0 ? (
        <CardSection title={t("workflows.digest.everythingElse")}>
          <ul>
            {digest.groups.map((group) => {
              const id = group.proposalId ?? null;
              const open = id !== null && openGroup === id && renderBatch !== undefined;
              const doIt =
                id === null
                  ? undefined
                  : renderBatch
                    ? () => setOpenGroup(open ? null : id)
                    : onGroup
                      ? () => onGroup(group)
                      : undefined;
              return (
                <GroupRow
                  key={`${group.category}:${group.title}`}
                  group={group}
                  open={open}
                  {...(doIt ? { onDoIt: doIt } : {})}
                  batch={open && id !== null ? renderBatch?.(id, () => setOpenGroup(null)) : null}
                />
              );
            })}
          </ul>
        </CardSection>
      ) : null}

      {digest.waitingOn.length > 0 ? (
        <CardSection title={t("workflows.digest.waitingOn")}>
          <ul>
            {digest.waitingOn.map((loop) => (
              <LoopRow key={loop.loop.id} loop={loop} now={now} {...(onLoop ? { onLoop } : {})} />
            ))}
          </ul>
        </CardSection>
      ) : null}

      {digest.screen.length > 0 ? (
        <CardSection title={t("workflows.digest.screen")}>
          <ul>
            {digest.screen.map((item) => (
              <ItemRow
                key={`${item.thread.account}:${item.thread.threadId}`}
                item={item}
                inline={SCREEN_ACTIONS}
                {...(onAction ? { onAction } : {})}
              />
            ))}
          </ul>
        </CardSection>
      ) : null}

      {digest.unverified.length > 0 ? (
        <CardSection
          title={
            <span className="inline-flex items-center gap-1.5">
              <ShieldQuestion className="size-3.5 text-approval-text" aria-hidden="true" />
              {t("workflows.digest.unverified")}
            </span>
          }
        >
          <p className="text-callout text-label-secondary">
            {t("workflows.digest.unverifiedHint")}
          </p>
          <ul>
            {digest.unverified.map((item) => (
              <ItemRow
                key={`${item.thread.account}:${item.thread.threadId}`}
                item={item}
                {...(onAction ? { onAction } : {})}
              />
            ))}
          </ul>
        </CardSection>
      ) : null}
    </WorkflowCardFrame>
  );
}
