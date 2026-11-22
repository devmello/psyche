import { type ReactElement, useId, useState } from "react";
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
import { Label } from "../components/ui/label.tsx";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { useSpaceActions } from "./use-spaces.ts";

export interface NewSpaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new Space's id and name once it exists; the dialog closes first. */
  onCreated: (spaceId: string, name: string) => void;
}

/** New Space: a name and an optional line on what it is for. Everything else is set on its page. */
export function NewSpaceDialog({
  open,
  onOpenChange,
  onCreated,
}: NewSpaceDialogProps): ReactElement {
  const nameId = useId();
  const descriptionId = useId();
  const actions = useSpaceActions();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setName("");
    setDescription("");
    setError(null);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("spaces.create.title")}</DialogTitle>
          <DialogDescription>{t("spaces.create.body")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = name.trim();
            if (trimmed === "" || busy) return;
            setBusy(true);
            setError(null);
            actions.create(trimmed, description.trim()).then(
              (id) => {
                setBusy(false);
                reset();
                onOpenChange(false);
                onCreated(id, trimmed);
              },
              (err: unknown) => {
                setBusy(false);
                setError(t("spaces.create.failed", { reason: describeError(err) }));
              },
            );
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>{t("spaces.create.name")}</Label>
            <Input
              id={nameId}
              value={name}
              maxLength={60}
              autoComplete="off"
              placeholder={t("spaces.create.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={descriptionId}>{t("spaces.create.description")}</Label>
            <Input
              id={descriptionId}
              value={description}
              maxLength={160}
              autoComplete="off"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-callout text-danger-text">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={name.trim() === "" || busy}>
              {t("spaces.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
