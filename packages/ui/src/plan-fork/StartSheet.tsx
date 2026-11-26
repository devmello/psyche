import type { PlanForkOption } from "@psyche/protocol";
import { Plus, X } from "lucide-react";
import { type ReactElement, useEffect, useId, useMemo, useState } from "react";
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
import { Textarea } from "../components/ui/textarea.tsx";
import { useCall, useSettings } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { FORK_LIMITS, formatUsd, type OptionDraft, readyOptions } from "./model.ts";

export interface StartSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId: string;
  messageId: string;
  /** Labels typed after `/compare`: they fill the rows and skip the suggestion. */
  labels?: string[];
  /** The chat is incognito: forks are refused. */
  incognito?: boolean;
  onStarted: (forkId: string) => void;
}

const blank = (): OptionDraft => ({ label: "", premise: "" });

/**
 * The start sheet (docs/design/fork-a-plan-2026.md §5.1): 2 to 4 options, each a label and a
 * premise, prefilled by one cheap suggestion call the owner edits. Under Start sits what a fork
 * costs at most and what it reads. Nothing runs until Start.
 */
export function PlanForkStartSheet({
  open,
  onOpenChange,
  threadId,
  messageId,
  labels,
  incognito = false,
  onStarted,
}: StartSheetProps): ReactElement {
  const call = useCall();
  const { settings } = useSettings();
  const uid = useId();
  const [rows, setRows] = useState<OptionDraft[]>([blank(), blank()]);
  const [suggesting, setSuggesting] = useState(false);
  const [estimate, setEstimate] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestOn = settings["forks.suggestOptions"] !== false;
  const labelKey = (labels ?? []).join("|");

  // Typed labels fill the rows; otherwise one suggestion does, unless the owner turned it off.
  useEffect(() => {
    if (!open || incognito) return;
    setError(null);
    if (labelKey !== "") {
      const typed = labelKey.split("|");
      setRows(
        Array.from({ length: Math.max(2, typed.length) }, (_, i) => ({
          label: typed[i] ?? "",
          premise: "",
        })),
      );
      return;
    }
    setRows([blank(), blank()]);
    if (!suggestOn) return;
    let live = true;
    setSuggesting(true);
    call("planForks.suggest", { threadId, messageId })
      .then((r) => {
        if (live && r.options.length >= 2)
          setRows(r.options.map((o: PlanForkOption) => ({ ...o })));
      })
      .catch(() => {})
      .finally(() => live && setSuggesting(false));
    return () => {
      live = false;
    };
  }, [open, incognito, labelKey, suggestOn, call, threadId, messageId]);

  const ready = useMemo(() => readyOptions(rows), [rows]);
  useEffect(() => {
    if (!open || ready == null) {
      setEstimate(null);
      return;
    }
    let live = true;
    call("planForks.estimate", { threadId, branches: ready })
      .then((r) => {
        if (!live) return;
        setEstimate(
          r.maxUsd != null
            ? t("planFork.sheet.estimate", { amount: formatUsd(r.maxUsd) })
            : t("planFork.sheet.estimateTokens", { count: r.maxTokens }),
        );
      })
      .catch(() => live && setEstimate(null));
    return () => {
      live = false;
    };
  }, [open, ready, call, threadId]);

  const set = (i: number, patch: Partial<OptionDraft>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const start = async () => {
    if (ready == null) return;
    setStarting(true);
    setError(null);
    try {
      const res = await call("planForks.create", { threadId, messageId, branches: ready });
      onOpenChange(false);
      onStarted(res.fork.id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="plan-fork-sheet" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("planFork.sheet.title")}</DialogTitle>
          <DialogDescription>{t("planFork.sheet.description")}</DialogDescription>
        </DialogHeader>
        {incognito ? (
          <p role="note" className="text-callout text-label-secondary">
            {t("planFork.sheet.incognito")}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {rows.map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place and have no ids
              <fieldset key={i} className="flex flex-col gap-1.5 border-0 p-0">
                <legend className="mb-1 flex w-full items-center justify-between text-subheadline font-medium text-label-secondary">
                  {t("planFork.sheet.option", { n: i + 1 })}
                  {rows.length > FORK_LIMITS.minOptions ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("planFork.sheet.removeOption", { n: i + 1 })}
                      onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  ) : null}
                </legend>
                <Input
                  id={`${uid}-l${i}`}
                  aria-label={t("planFork.sheet.label", { n: i + 1 })}
                  value={row.label}
                  maxLength={FORK_LIMITS.label}
                  placeholder={suggesting ? t("planFork.sheet.suggesting") : ""}
                  onChange={(e) => set(i, { label: e.target.value })}
                />
                <Textarea
                  id={`${uid}-p${i}`}
                  aria-label={t("planFork.sheet.premise", { n: i + 1 })}
                  value={row.premise}
                  maxLength={FORK_LIMITS.premise}
                  rows={2}
                  placeholder={t("planFork.sheet.assume")}
                  onChange={(e) => set(i, { premise: e.target.value })}
                />
              </fieldset>
            ))}
            {rows.length < FORK_LIMITS.maxOptions ? (
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => setRows((rs) => [...rs, blank()])}
              >
                <Plus aria-hidden="true" /> {t("planFork.sheet.addOption")}
              </Button>
            ) : null}
            <p className="m-0 text-callout text-label-secondary" data-testid="plan-fork-estimate">
              {estimate != null ? `${estimate} · ` : ""}
              {t("planFork.sheet.reads")}
            </p>
            {error != null ? (
              <p role="alert" className="m-0 text-callout text-danger-text">
                {error}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("planFork.cancel")}
          </Button>
          {incognito ? null : (
            <Button disabled={ready == null || starting} onClick={() => void start()}>
              {starting ? t("planFork.sheet.starting") : t("planFork.sheet.start")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
