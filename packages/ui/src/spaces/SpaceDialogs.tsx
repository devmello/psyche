import { SPACE_LIMITS, type SpaceContextSection } from "@psyche/protocol";
import { type ReactElement, useEffect, useId, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { Label } from "../components/ui/label.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { useCall, useGatewayQuery } from "../data/index.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";

const num = (n: number) => activeI18n().number(n);

/** Edit instructions: a plain text field and the count "1,240 of 4,000". */
export function InstructionsDialog({
  open,
  onOpenChange,
  spaceId,
  name,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaceId: string;
  name: string;
  initial: string;
  onSaved: () => void;
}): ReactElement {
  const fieldId = useId();
  const call = useCall();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A fresh copy of what is saved every time the sheet opens.
  useEffect(() => {
    if (open) {
      setText(initial);
      setError(null);
    }
  }, [open, initial]);
  const over = text.length > SPACE_LIMITS.instructions;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("spaces.instructions.title")}</DialogTitle>
          <DialogDescription>{t("spaces.instructions.body")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || over) return;
            setBusy(true);
            setError(null);
            call("spaces.update", { spaceId, instructions: text }).then(
              () => {
                setBusy(false);
                onSaved();
                onOpenChange(false);
              },
              (err: unknown) => {
                setBusy(false);
                setError(t("spaces.instructions.failed", { reason: describeError(err) }));
              },
            );
          }}
        >
          <Label htmlFor={fieldId} className="sr-only">
            {t("spaces.instructions.label", { name })}
          </Label>
          <Textarea
            id={fieldId}
            value={text}
            rows={10}
            onChange={(e) => setText(e.target.value)}
            aria-describedby={`${fieldId}-count`}
          />
          <p
            id={`${fieldId}-count`}
            className={over ? "text-callout text-danger-text" : "text-callout text-label-secondary"}
          >
            {t("spaces.instructions.count", {
              n: num(text.length),
              max: num(SPACE_LIMITS.instructions),
            })}
          </p>
          {error ? (
            <p role="alert" className="text-callout text-danger-text">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || over || text === initial}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const SECTION_TITLE: Record<SpaceContextSection["kind"], () => string> = {
  instructions: () => t("spaces.preview.section.instructions"),
  card: () => t("spaces.preview.section.card"),
  work: () => t("spaces.preview.section.work"),
  trackers: () => t("spaces.preview.section.trackers"),
};

/** What Psyche sees here (`spaces.context.preview`): the exact sections, with their sizes. */
export function ContextPreviewDialog({
  open,
  onOpenChange,
  spaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaceId: string;
}): ReactElement {
  const q = useGatewayQuery("spaces.context.preview", { spaceId }, { enabled: open });
  const sections = q.data?.sections ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("spaces.preview.title")}</DialogTitle>
          <DialogDescription>{t("spaces.preview.body")}</DialogDescription>
        </DialogHeader>
        {q.error ? (
          <p role="alert" className="text-callout text-danger-text">
            {q.error}
          </p>
        ) : sections.length === 0 && !q.loading ? (
          <p className="text-body text-label-secondary">{t("spaces.preview.empty")}</p>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
            {sections.map((s) => (
              <section key={s.kind} className="flex flex-col gap-1">
                <h3 className="flex items-baseline justify-between gap-2 text-headline text-label-primary">
                  {SECTION_TITLE[s.kind]()}
                  <span className="text-callout font-normal text-label-secondary tabular-nums">
                    {t("spaces.preview.size", { chars: num(s.chars), cap: num(s.cap) })}
                  </span>
                </h3>
                <pre className="whitespace-pre-wrap rounded-md bg-fill-quaternary p-2 text-callout text-label-primary">
                  {s.text}
                </pre>
              </section>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Delete a Space: what stays and what stops, then one button. */
export function DeleteSpaceDialog({
  open,
  onOpenChange,
  name,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onConfirm: () => void;
}): ReactElement {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("spaces.delete.title", { name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("spaces.delete.body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            {t("spaces.delete.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
