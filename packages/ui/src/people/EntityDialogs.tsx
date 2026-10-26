import type { EntitySummary, MethodResult } from "@psyche/protocol";
import { type ReactElement, useEffect, useId, useState } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { useCall } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { EntityRow } from "./EntityRow.tsx";
import { useEntitySearch } from "./hooks.ts";

/**
 * Forget and Merge (docs/memory/people-and-projects-2026.md §4.9, §6.1, §6.5). Both run the
 * Gateway's dry run first and say what will change before anything does; Forget is destructive
 * (its button trails in danger, redesign §5.8).
 */

interface Target {
  id: string;
  name: string;
}

type ForgetResult = MethodResult<"memory.entities.forget">;

export interface ForgetEntityDialogProps {
  entity: Target | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After the entity is gone (the host closes its card). */
  onForgotten?: (entity: Target) => void;
}

export function ForgetEntityDialog({
  entity,
  open,
  onOpenChange,
  onForgotten,
}: ForgetEntityDialogProps): ReactElement {
  const call = useCall();
  const [preview, setPreview] = useState<ForgetResult["removed"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || entity === null) return;
    let live = true;
    setPreview(null);
    setError(null);
    call("memory.entities.forget", { id: entity.id, dryRun: true }).then(
      (r) => live && setPreview(r.removed),
      (err: unknown) => live && setError(describeError(err)),
    );
    return () => {
      live = false;
    };
  }, [open, entity, call]);

  const forget = () => {
    if (entity === null) return;
    setBusy(true);
    call("memory.entities.forget", { id: entity.id })
      .then(() => {
        toast(t("people.forget.done", { name: entity.name }));
        onOpenChange(false);
        onForgotten?.(entity);
      })
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setBusy(false));
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("people.forget.title", { name: entity?.name ?? "" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {preview
              ? t("people.forget.counts", {
                  facts: preview.facts,
                  loops: preview.loops,
                  interactions: preview.interactions,
                  edges: preview.edges,
                })
              : error
                ? t("people.forget.previewFailed", { reason: error })
                : t("people.forget.counting")}
          </AlertDialogDescription>
          <p className="text-callout text-label-secondary">{t("people.forget.after")}</p>
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
            variant="destructive"
            disabled={busy || preview === null}
            onClick={forget}
          >
            {t("people.forget.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type MergePreview = MethodResult<"memory.entities.merge">;

export interface MergeEntityDialogProps {
  /** The entity that stays. */
  entity: Target | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preselects the one to merge in (a suggestion). */
  other?: Target | null;
  onMerged?: (into: Target) => void;
}

/** Pick who else this is, see what moves (dry run), then merge into this entity. */
export function MergeEntityDialog({
  entity,
  open,
  onOpenChange,
  other: preset = null,
  onMerged,
}: MergeEntityDialogProps): ReactElement {
  const call = useCall();
  const searchId = useId();
  const [q, setQ] = useState("");
  const [other, setOther] = useState<Target | null>(preset);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const results = useEntitySearch(q, { enabled: open && other === null, kinds: ["person", "org"] });

  useEffect(() => {
    if (open) {
      setOther(preset);
      setQ("");
    }
  }, [open, preset]);

  useEffect(() => {
    setPreview(null);
    setError(null);
    if (!open || entity === null || other === null) return;
    let live = true;
    call("memory.entities.merge", {
      ids: [entity.id, other.id],
      into: entity.id,
      dryRun: true,
    }).then(
      (r) => live && setPreview(r),
      (err: unknown) => live && setError(describeError(err)),
    );
    return () => {
      live = false;
    };
  }, [open, entity, other, call]);

  const merge = () => {
    if (entity === null || other === null) return;
    setBusy(true);
    call("memory.entities.merge", { ids: [entity.id, other.id], into: entity.id })
      .then(() => {
        toast(t("people.merge.done", { other: other.name, name: entity.name }));
        onOpenChange(false);
        onMerged?.(entity);
      })
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setBusy(false));
  };

  const candidates = results.entities.filter((e: EntitySummary) => e.id !== entity?.id);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("people.merge.title", { name: entity?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("people.merge.description")}</DialogDescription>
        </DialogHeader>
        {other === null ? (
          <div className="flex flex-col gap-2">
            <label htmlFor={searchId} className="text-body text-label-primary">
              {t("people.merge.search")}
            </label>
            <Input
              id={searchId}
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("people.merge.searchPlaceholder")}
            />
            <div className="flex max-h-60 flex-col overflow-y-auto">
              {candidates.map((c) => (
                <EntityRow
                  key={c.id}
                  entity={c}
                  now={Date.now()}
                  onOpen={(e) => setOther({ id: e.id, name: e.name })}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-body text-label-primary" role="status">
              {preview
                ? t("people.merge.preview", {
                    identifiers: preview.movedIdentifiers,
                    facts: preview.movedFacts,
                    other: other.name,
                    name: entity?.name ?? "",
                  })
                : error
                  ? t("people.writeFailed", { reason: error })
                  : t("people.merge.checking")}
            </p>
            {preset === null ? (
              <div>
                <Button type="button" size="sm" variant="ghost" onClick={() => setOther(null)}>
                  {t("people.merge.pickAnother")}
                </Button>
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("people.dialog.cancel")}
          </Button>
          <Button type="button" disabled={busy || preview === null} onClick={merge}>
            {t("people.merge.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
