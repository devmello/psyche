import { Check, ExternalLink, PenLine } from "lucide-react";
import * as m from "motion/react-m";
import { type ReactElement, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { easeLinear } from "../../motion/index.ts";
import { CloudChip, TaintChip, WorkflowCardFrame } from "./shared.tsx";
import { DRAFT_TONES, type DraftTone, type DraftView } from "./types.ts";

/** Lines of the draft shown before "Show the whole draft" (§7.1). */
export const DRAFT_LINES = 3;

export interface DraftCardProps {
  draft: DraftView;
  /** The focused card holds the one accent primary (redesign-2026 §5.6). */
  focused?: boolean;
  onTone?: (tone: DraftTone) => void;
  onOpen?: (link: string) => void;
  /** Raises the standard approval dock with the `send_email` binding; never sends by itself. */
  onSend?: () => void;
  /** Send arms after this delay, like an approval (tests may set 0). */
  armDelayMs?: number;
  className?: string;
}

/**
 * A reply drafted in the owner's voice (docs/workflows/mail-and-meetings-2026.md §7.1, §4.3): the
 * recipient, the subject and the first three lines, the tone chips, and Open in Mail and Send.
 * The draft is already saved in the owner's Drafts; Send goes through the approval dock.
 */
export function DraftCard({
  draft,
  focused = false,
  onTone,
  onOpen,
  onSend,
  armDelayMs = 400,
  className,
}: DraftCardProps): ReactElement {
  const [all, setAll] = useState(false);
  const [armed, setArmed] = useState(armDelayMs === 0);
  useEffect(() => {
    if (armDelayMs === 0) return;
    const timer = setTimeout(() => setArmed(true), armDelayMs);
    return () => clearTimeout(timer);
  }, [armDelayMs]);
  const lines = draft.body.split("\n");
  const long = lines.length > DRAFT_LINES;
  const shown = all || !long ? draft.body : lines.slice(0, DRAFT_LINES).join("\n");
  const busy = draft.status === "rewriting";
  const sent = draft.status === "sent";
  const link = draft.link ?? null;

  return (
    <WorkflowCardFrame
      data-kind="draft"
      kind={t("workflows.kind.draft")}
      title={draft.subject}
      chips={
        <>
          {draft.voiceUsed ? (
            <span className="inline-flex items-center gap-1">
              <PenLine className="size-3" aria-hidden="true" />
              {t("workflows.draft.voice")}
            </span>
          ) : null}
          {draft.taintFrom !== undefined ? <TaintChip from={draft.taintFrom} /> : null}
          {draft.usedCloudModel ? <CloudChip /> : null}
        </>
      }
      {...(className ? { className } : {})}
    >
      <p className="text-callout text-label-secondary">
        {t("workflows.draft.to", { to: draft.to })}
      </p>
      <div
        className={cn(
          "rounded-md bg-fill-quaternary px-3 py-2 text-reading whitespace-pre-wrap text-label-primary transition-opacity",
          busy ? "opacity-60" : "",
        )}
        aria-busy={busy}
      >
        {shown}
        {long && !all ? "…" : null}
      </div>
      {long ? (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="cursor-default self-start rounded-xs text-callout text-accent-11 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {all ? t("workflows.draft.showLess") : t("workflows.draft.showAll")}
        </button>
      ) : null}
      {draft.commitments.length > 0 ? (
        <p className="text-callout text-approval-text">
          {t("workflows.draft.commitments", {
            list: draft.commitments.map((c) => `“${c}”`).join(", "),
          })}
        </p>
      ) : null}

      {sent ? (
        <p className="inline-flex items-center gap-1.5 text-callout text-label-secondary">
          <Check className="size-4 text-success-text" aria-hidden="true" />
          {t("workflows.draft.sent")}
        </p>
      ) : (
        <>
          {onTone ? (
            <fieldset className="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0">
              <legend className="sr-only">{t("workflows.draft.tone")}</legend>
              {DRAFT_TONES.map((tone) => (
                <Button
                  key={tone}
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onTone(tone)}
                  className="rounded-full"
                >
                  {t(`workflows.draft.tone.${tone}`)}
                </Button>
              ))}
              {busy ? (
                <span className="text-callout text-label-secondary" aria-live="polite">
                  {t("workflows.draft.rewriting")}
                </span>
              ) : null}
            </fieldset>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="me-auto text-callout text-label-secondary">
              {t("workflows.draft.saved")}
            </span>
            {link && onOpen ? (
              <Button type="button" variant="outline" size="sm" onClick={() => onOpen(link)}>
                <ExternalLink aria-hidden="true" />
                {t("workflows.openInMail")}
              </Button>
            ) : null}
            {onSend ? (
              <Button
                type="button"
                size="sm"
                variant={focused && armed ? "default" : "secondary"}
                disabled={!armed || busy}
                onClick={onSend}
                className="relative overflow-hidden"
              >
                {t("workflows.draft.send")}
                {!armed ? (
                  <m.span
                    className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-accent-9"
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ duration: armDelayMs / 1000, ease: easeLinear }}
                    aria-hidden="true"
                  />
                ) : null}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </WorkflowCardFrame>
  );
}
