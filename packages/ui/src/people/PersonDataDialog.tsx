import type { PersonRemoved } from "@psyche/protocol";
import { type ReactElement, useEffect, useState } from "react";
import { toast } from "sonner";
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
import { useCall } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";

/**
 * "Forget what they said" and "Exclude" for one person (docs/design/everything-memory-2026.md
 * §10.1, §10.3). Both start with a count of what would go, from a dry run, and only then ask.
 */
export type PersonDataMode = "said" | "exclude" | "exclude_forget";

export function PersonDataDialog({
  person,
  mode,
  open,
  onOpenChange,
  onDone,
}: {
  person: { id: string; name: string } | null;
  mode: PersonDataMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}): ReactElement {
  const call = useCall();
  const [preview, setPreview] = useState<PersonRemoved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (dryRun: boolean) =>
    mode === "said"
      ? call("memory.entities.forgetSaid", { id: person?.id ?? "", dryRun }).then((r) => r.removed)
      : call("memory.entities.exclude", {
          id: person?.id ?? "",
          mode: mode === "exclude" ? "exclude" : "forget",
          dryRun,
        }).then((r) => r.removed);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the dry run belongs to open/person/mode
  useEffect(() => {
    if (!open || person === null) return;
    let live = true;
    setPreview(null);
    setError(null);
    run(true).then(
      (r) => live && setPreview(r),
      (err: unknown) => live && setError(describeError(err)),
    );
    return () => {
      live = false;
    };
  }, [open, person?.id, mode]);

  const confirm = () => {
    setBusy(true);
    run(false)
      .then(() => {
        toast(t(`personData.done.${mode}`, { name: person?.name ?? "" }));
        onOpenChange(false);
        onDone?.();
      })
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setBusy(false));
  };

  const removes = mode !== "exclude";
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(`personData.title.${mode}`, { name: person?.name ?? "" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {preview
              ? removes
                ? t("personData.counts", {
                    facts: preview.facts,
                    quotes: preview.citations,
                    held: preview.quarantine,
                  })
                : t("personData.excludeOnly")
              : error
                ? t("people.forget.previewFailed", { reason: error })
                : t("people.forget.counting")}
          </AlertDialogDescription>
          <p className="text-callout text-label-secondary">{t(`personData.after.${mode}`)}</p>
        </AlertDialogHeader>
        {error && preview ? (
          <p role="alert" className="text-callout text-danger-text">
            {t("people.writeFailed", { reason: error })}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("people.dialog.cancel")}</AlertDialogCancel>
          <Button
            type="button"
            variant={removes ? "destructive" : "default"}
            disabled={busy || preview === null}
            onClick={confirm}
          >
            {t(`personData.confirm.${mode}`)}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
