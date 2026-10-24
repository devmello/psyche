import type { Goal } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { GOAL_CATEGORY_LABEL, GOAL_CATEGORY_ORDER } from "./goal-plan.ts";

export interface AddGoalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Creates the goal; the dialog closes when it resolves and shows the error when it rejects. */
  onAdd: (title: string, category: Goal["category"]) => Promise<unknown>;
}

/**
 * Add a goal (#554): a title and a category, active at once. Plans, milestones and check-ins come
 * later, from the goal page or the chat.
 */
export function AddGoalDialog({ open, onOpenChange, onAdd }: AddGoalDialogProps): ReactElement {
  const titleId = useId();
  const categoryId = useId();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<Goal["category"]>("other");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setTitle("");
    setCategory("other");
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
          <DialogTitle>{t("screens.goals.addTitle")}</DialogTitle>
          <DialogDescription>{t("screens.goals.addBody")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const name = title.trim();
            if (name === "" || busy) return;
            setBusy(true);
            setError(null);
            onAdd(name, category).then(
              () => {
                setBusy(false);
                reset();
                onOpenChange(false);
              },
              (err: unknown) => {
                setBusy(false);
                setError(t("screens.goals.addFailed", { reason: describeError(err) }));
              },
            );
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={titleId}>{t("screens.goals.addName")}</Label>
            <Input
              id={titleId}
              value={title}
              autoComplete="off"
              placeholder={t("screens.goals.addPlaceholder")}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={categoryId}>{t("screens.goals.addCategory")}</Label>
            <NativeSelect
              id={categoryId}
              value={category}
              onChange={(e) => setCategory(e.target.value as Goal["category"])}
            >
              {GOAL_CATEGORY_ORDER.map((c) => (
                <option key={c} value={c}>
                  {GOAL_CATEGORY_LABEL[c]}
                </option>
              ))}
            </NativeSelect>
          </div>
          {error ? (
            <p role="alert" className="text-small text-danger-text">
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={title.trim() === "" || busy}>
              {busy ? t("common.saving") : t("screens.goals.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
