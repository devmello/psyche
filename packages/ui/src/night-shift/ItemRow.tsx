import type { StagedAction } from "@psyche/protocol";
import { ChevronDown } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import {
  hasNewRecipient,
  hasSend,
  readPreview,
  type Selection,
  sendBlock,
  tickable,
  undoable,
} from "./model.ts";
import { Preview } from "./Preview.tsx";

export interface ItemRowProps {
  item: StagedAction;
  selection: Selection;
  now: number;
  busy: boolean;
  onToggle: () => void;
  onToggleSend: () => void;
  /** The owner opened the full draft. */
  onOpen: () => void;
  onUndo: () => void;
}

/** The line a finished or refused item shows in place of its tick. */
function StatusLine({ item, refused }: { item: StagedAction; refused: string | undefined }) {
  const reason = item.result?.error;
  let line: string | null = null;
  let tone = "text-label-secondary";
  if (refused !== undefined) {
    line = t("nightShift.row.refused", { reason: refused });
    tone = "text-destructive";
  } else if (item.status === "applied") line = t("nightShift.status.applied");
  else if (item.status === "failed") {
    line = reason ? t("nightShift.status.failed", { reason }) : t("nightShift.status.failedPlain");
    tone = "text-destructive";
  } else if (item.status === "uncertain")
    line = t("nightShift.status.uncertain", { domain: item.domain });
  else if (item.status === "stale") line = reason ?? t("nightShift.row.staleDefault");
  else if (item.status === "skipped") line = t("nightShift.status.skipped");
  else if (item.status === "expired") line = t("nightShift.status.expired");
  else if (item.status === "dismissed") line = t("nightShift.status.dismissed");
  else if (item.status === "undone") line = t("nightShift.status.undone");
  if (line === null) return null;
  return (
    <p className={cn("text-callout", tone)} data-testid="night-shift-status">
      {line}
    </p>
  );
}

/**
 * One prepared change: a checkbox, a one-line summary, badges, and a details expander. Stale and
 * refused items cannot be ticked. A reply draft that can be sent has a second box, "Send it
 * too", that starts off, is its own choice, and stays disabled until the draft is ticked and, if
 * the preview is cut, until the full draft has been opened.
 */
export function ItemRow({
  item,
  selection,
  now,
  busy,
  onToggle,
  onToggleSend,
  onOpen,
  onUndo,
}: ItemRowProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const preview = readPreview(item.preview);
  const canTick = tickable(item, selection);
  const ticked = selection.ticked.has(item.id);
  const send = hasSend(item) ? item.send : null;
  const block = send ? sendBlock(item, selection) : null;
  const refused = selection.refused.get(item.id);
  const newRecipient = hasNewRecipient(preview);
  return (
    <li
      className="flex flex-col gap-2 px-2.5 py-2.5"
      data-testid={`night-shift-row-${item.id}`}
      data-status={item.status}
    >
      <div className="flex items-start gap-3">
        <Checkbox
          className="mt-1"
          aria-label={t("nightShift.row.select", { summary: item.summary })}
          checked={ticked}
          disabled={!canTick || busy}
          onCheckedChange={() => onToggle()}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-body text-label-primary">{item.summary}</p>
          {item.status === "stale" || item.taint || newRecipient || preview.replyAll ? (
            <div className="flex flex-wrap gap-1.5">
              {item.status === "stale" ? (
                <Badge variant="muted">{t("nightShift.badge.stale")}</Badge>
              ) : null}
              {item.taint ? (
                <Badge variant="outline">{t("nightShift.badge.untrusted")}</Badge>
              ) : null}
              {newRecipient ? (
                <Badge variant="approval">{t("nightShift.badge.newRecipient")}</Badge>
              ) : null}
              {preview.replyAll ? (
                <Badge variant="approval">{t("nightShift.badge.replyAll")}</Badge>
              ) : null}
            </div>
          ) : null}
          {item.why ? (
            <p className="text-callout text-label-secondary">
              {t("nightShift.row.why", { why: item.why })}
            </p>
          ) : null}
          <StatusLine item={item} refused={refused} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {undoable(item, now) ? (
            <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onUndo}>
              {t("nightShift.undo")}
            </Button>
          ) : null}
          {preview.rows.length > 0 ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              aria-controls={`${id}-details`}
              onClick={() => {
                setExpanded(!expanded);
                if (!expanded) onOpen();
              }}
            >
              {expanded ? t("nightShift.row.hide") : t("nightShift.row.show")}
              <ChevronDown
                aria-hidden="true"
                className={cn("transition-transform", expanded && "rotate-180")}
              />
            </Button>
          ) : null}
        </div>
      </div>
      {expanded && preview.rows.length > 0 ? (
        <div id={`${id}-details`} className="ps-7">
          <Preview preview={preview} />
        </div>
      ) : null}
      {send ? (
        <div className="flex flex-col gap-0.5 ps-7" data-testid={`night-shift-send-${item.id}`}>
          <div className="flex items-center gap-2 text-body text-label-primary">
            <Checkbox
              id={`${id}-send`}
              checked={selection.sends.has(item.id)}
              disabled={block !== null || busy}
              onCheckedChange={() => onToggleSend()}
            />
            <label htmlFor={`${id}-send`}>{t("nightShift.send.label")}</label>
          </div>
          <p className="ps-6 text-callout text-label-secondary">
            {t("nightShift.send.to", { recipients: send.recipients.join(", ") })}
          </p>
          {block === "draft" ? (
            <p className="ps-6 text-callout text-label-secondary">
              {t("nightShift.send.needsDraft")}
            </p>
          ) : null}
          {block === "truncated" ? (
            <p className="ps-6 text-callout text-label-secondary">
              {t("nightShift.send.needsFull")}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
