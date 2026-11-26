import type { PlanFork, PlanForkBranch, StagedAction } from "@psyche/protocol";
import { type ReactElement, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { useCall } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { takePlan, useForkStaged } from "./data.ts";
import type { TakeSelection } from "./model.ts";

/**
 * The selection the sheet starts with: every fresh (`ready`) item ticked, every other item off,
 * and every send box off. A send is always the owner's own separate tick (Night shift §3.2).
 */
export function initialTicks(items: readonly StagedAction[]): {
  items: Record<string, boolean>;
  sends: Record<string, boolean>;
} {
  return {
    items: Object.fromEntries(
      items.map((i) => [i.id, i.status === "ready" && i.withheld === undefined]),
    ),
    sends: Object.fromEntries(items.filter((i) => i.send != null).map((i) => [i.id, false])),
  };
}

type Ticks = ReturnType<typeof initialTicks>;

/**
 * The ticks after the items were read again (a fork emits `planFork.updated` all the time): the
 * owner's item and send ticks stay for every id still listed with the same binding hash and a
 * fresh status. An id whose hash changed, or that is no longer fresh, is unticked (never
 * re-ticked, so Take cannot approve what the owner left out or what is no longer what they saw).
 * Only ids that were not listed before get the initial ticks.
 */
export function mergeTicks(
  current: Ticks,
  before: readonly StagedAction[],
  after: readonly StagedAction[],
): Ticks {
  const was = new Map(before.map((i) => [i.id, i]));
  const fresh = initialTicks(after);
  const out: Ticks = { items: {}, sends: {} };
  for (const i of after) {
    const old = was.get(i.id);
    if (old === undefined) {
      out.items[i.id] = fresh.items[i.id] === true;
      if (i.id in fresh.sends) out.sends[i.id] = false;
      continue;
    }
    const same =
      old.bindingHash === i.bindingHash && i.status === "ready" && i.withheld === undefined;
    out.items[i.id] = same && current.items[i.id] === true;
    if (i.send != null) {
      const sameSend = same && old.send?.contentHash === i.send.contentHash;
      out.sends[i.id] = sameSend && current.sends[i.id] === true;
    }
  }
  return out;
}

/** What `planForks.take` is asked for, from the ticks. A send counts only on a ticked item. */
export function selectionOf(
  items: readonly StagedAction[],
  ticks: { items: Record<string, boolean>; sends: Record<string, boolean> },
): TakeSelection {
  const on = items.filter((i) => ticks.items[i.id] === true);
  return {
    items: on.map((i) => ({ itemId: i.id, bindingHash: i.bindingHash })),
    sends: on.flatMap((i) =>
      i.send != null && ticks.sends[i.id] === true
        ? [{ itemId: i.id, sendHash: i.send.contentHash }]
        : [],
    ),
  };
}

function Preview({ item }: { item: StagedAction }): ReactElement | null {
  if (item.withheld !== undefined) {
    return <p className="m-0 text-callout text-label-secondary">{t("planFork.take.withheld")}</p>;
  }
  if (item.preview == null) return null;
  return (
    <dl className="m-0 grid grid-cols-[5rem_1fr] gap-x-2 gap-y-0.5 text-callout">
      {item.preview.rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no ids
        <div key={i} className="contents">
          <dt className="text-label-secondary">{r.label}</dt>
          <dd className="m-0 break-words text-label-primary">
            {r.value}
            {r.badge === "new_recipient" ? (
              <span className="ms-1.5 rounded-xs bg-fill-quaternary px-1.5 py-0.5 text-footnote text-label-secondary">
                {t("planFork.take.newRecipient")}
              </span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface TakeSheetProps {
  fork: PlanFork;
  branch: PlanForkBranch;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

/**
 * The Take sheet (docs/design/fork-a-plan-2026.md §3.4): the branch's prepared items with
 * checkboxes (fresh ones ticked), each send behind its own unticked "Send it too" box, then the
 * steps Psyche or the owner does after. Take asks for one approval, and the client answers it only
 * if the card lists exactly the ticked items (`takePlan`).
 */
export function TakeSheet({
  fork,
  branch,
  open,
  onOpenChange,
  onDone,
}: TakeSheetProps): ReactElement {
  const call = useCall();
  const uid = useId();
  const { items, loading, error: loadFailed } = useForkStaged(fork.id, branch.id, open);
  const [ticks, setTicks] = useState(() => initialTicks([]));
  const [carryOn, setCarryOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Initial ticks once per open and branch; a re-read keeps the owner's choices (`mergeTicks`).
  const seen = useRef<{ scope: string; items: readonly StagedAction[] }>({ scope: "", items: [] });
  useEffect(() => {
    const scope = `${open}:${branch.id}`;
    if (seen.current.scope !== scope) {
      seen.current = { scope, items };
      setTicks(initialTicks(items));
      return;
    }
    const before = seen.current.items;
    seen.current = { scope, items };
    setTicks((cur) => mergeTicks(cur, before, items));
  }, [items, open, branch.id]);
  const steps = branch.report?.steps ?? [];
  const stagedIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  const loose = steps.filter((s) => s.stagedId === undefined || !stagedIds.has(s.stagedId));
  const psycheLoose = loose.some((s) => s.who === "psyche");
  const selection = selectionOf(items, ticks);

  const take = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const out = await takePlan(call, {
        forkId: fork.id,
        branchId: branch.id,
        selection,
        continue: carryOn,
      });
      if (out.kind === "mismatch") setNotice(t("planFork.take.mismatch"));
      else if (out.kind === "declined") setNotice(t("planFork.take.declined"));
      else if (out.kind === "refused") {
        setNotice(t("planFork.take.refused", { count: out.items.length }));
        if (out.applied) onDone();
      } else onDone();
    } catch (err) {
      setNotice(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="plan-take-sheet"
        className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>{t("planFork.take.title", { label: branch.label })}</DialogTitle>
          <DialogDescription>{t("planFork.take.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {loading ? (
            <p className="m-0 text-callout text-label-secondary">{t("planFork.card.loading")}</p>
          ) : null}
          {loadFailed ? (
            <p role="alert" className="m-0 text-callout text-danger-text">
              {t("planFork.take.loadFailed")}
            </p>
          ) : null}
          {items.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {items.map((item) => {
                const fresh = item.status === "ready" && item.withheld === undefined;
                const on = ticks.items[item.id] === true;
                return (
                  <li
                    key={item.id}
                    className="flex flex-col gap-1.5 rounded-md border border-separator p-3"
                  >
                    <div className="flex items-start gap-2">
                      <Checkbox
                        id={`${uid}-${item.id}`}
                        aria-label={item.summary}
                        checked={on}
                        disabled={!fresh}
                        onCheckedChange={(v) =>
                          setTicks((s) => ({
                            items: { ...s.items, [item.id]: v === true },
                            sends: v === true ? s.sends : { ...s.sends, [item.id]: false },
                          }))
                        }
                      />
                      <label
                        htmlFor={`${uid}-${item.id}`}
                        className="min-w-0 flex-1 text-body font-medium text-label-primary"
                      >
                        {item.withheld !== undefined
                          ? t("planFork.take.withheldTitle")
                          : item.summary}
                      </label>
                      {!fresh && item.withheld === undefined ? (
                        <span className="text-footnote text-label-secondary">
                          {item.status === "stale"
                            ? t("planFork.item.stale")
                            : t("planFork.item.unavailable")}
                        </span>
                      ) : null}
                    </div>
                    <Preview item={item} />
                    {item.send != null && item.withheld === undefined ? (
                      <div className="flex items-center gap-2 ps-6">
                        <Checkbox
                          id={`${uid}-${item.id}-send`}
                          aria-label={t("planFork.take.sendAria", { summary: item.summary })}
                          checked={ticks.sends[item.id] === true}
                          disabled={!on || item.preview?.truncated === true}
                          onCheckedChange={(v) =>
                            setTicks((s) => ({
                              ...s,
                              sends: { ...s.sends, [item.id]: v === true },
                            }))
                          }
                        />
                        <label
                          htmlFor={`${uid}-${item.id}-send`}
                          className="text-callout text-label-primary"
                        >
                          {t("planFork.take.sendToo")}
                        </label>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {loose.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-callout">
              {loose.map((s) => (
                <li key={s.id} className="flex flex-col">
                  <span className="text-label-primary">{s.text}</span>
                  <span className="text-footnote text-label-secondary">
                    {s.who === "psyche" ? t("planFork.psycheDoes") : t("planFork.youDo")}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {psycheLoose ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${uid}-continue`}
                checked={carryOn}
                onCheckedChange={(v) => setCarryOn(v === true)}
              />
              <label htmlFor={`${uid}-continue`} className="text-callout text-label-primary">
                {t("planFork.take.continue")}
              </label>
            </div>
          ) : null}
          {notice != null ? (
            <p role="alert" className="m-0 text-callout text-danger-text">
              {notice}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("planFork.cancel")}
          </Button>
          <Button disabled={busy || loading} onClick={() => void take()}>
            {t("planFork.take")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
