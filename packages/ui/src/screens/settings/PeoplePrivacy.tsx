import type { GraphRemovedCounts, GraphSource, GraphStatus } from "@psyche/protocol";
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
} from "../../components/ui/alert-dialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { formatDate } from "../../lib/format.ts";
import { Group } from "./shared.tsx";

/**
 * The privacy half of Settings → People & projects (docs/memory/people-and-projects-2026.md §4.9,
 * §6.7, §7): blocked addresses (unblock, or block one by hand), deleting what one source produced
 * (with the Gateway's dry-run counts first), and forgetting the whole graph behind a typed
 * confirmation. Every delete says what it removes before anything is removed.
 */

/** The phrase `memory.graph.forgetAll` requires, typed by the owner (fixed by the protocol). */
export const FORGET_ALL_PHRASE = "forget everything";

type Target = { kind: "source"; source: GraphSource } | { kind: "all" };
type BlockKind = "email" | "phone" | "domain";
const BLOCK_KINDS: readonly BlockKind[] = ["email", "domain", "phone"];

function countsText(r: GraphRemovedCounts): string {
  return t("settings.people.removeCounts", {
    entities: r.entities,
    facts: r.facts,
    interactions: r.interactions,
    loops: r.loops,
    identifiers: r.identifiers,
  });
}

function DeleteDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: Target | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}): ReactElement {
  const call = useCall();
  const confirmId = useId();
  const [preview, setPreview] = useState<GraphRemovedCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const all = target?.kind === "all";
  const sourceName = target?.kind === "source" ? t(`settings.people.source.${target.source}`) : "";

  useEffect(() => {
    setPreview(null);
    setError(null);
    setTyped("");
    if (target === null) return;
    let live = true;
    const dry =
      target.kind === "all"
        ? call("memory.graph.forgetAll", { confirm: FORGET_ALL_PHRASE, dryRun: true })
        : call("memory.graph.deleteSource", { source: target.source, dryRun: true });
    dry.then(
      (r) => live && setPreview(r.removed),
      (err: unknown) => live && setError(describeError(err)),
    );
    return () => {
      live = false;
    };
  }, [target, call]);

  const confirmed = !all || typed.trim().toLowerCase() === FORGET_ALL_PHRASE;
  const run = () => {
    if (target === null) return;
    setBusy(true);
    const work =
      target.kind === "all"
        ? call("memory.graph.forgetAll", { confirm: FORGET_ALL_PHRASE })
        : call("memory.graph.deleteSource", { source: target.source });
    work
      .then(() => {
        toast(
          target.kind === "all"
            ? t("settings.people.forgotAll")
            : t("settings.people.deletedSource", { source: sourceName }),
        );
        onOpenChange(false);
        onDone();
      })
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setBusy(false));
  };

  return (
    <AlertDialog open={target !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {all
              ? t("settings.people.forgetAllTitle")
              : t("settings.people.deleteSourceTitle", { source: sourceName })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {preview
              ? countsText(preview)
              : error
                ? t("settings.people.previewFailed", { reason: error })
                : t("settings.people.counting")}
          </AlertDialogDescription>
          <p className="text-callout text-label-secondary">
            {all
              ? t("settings.people.forgetAllAfter")
              : t("settings.people.deleteSourceAfter", { source: sourceName })}
          </p>
        </AlertDialogHeader>
        {all ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={confirmId} className="text-body text-label-primary">
              {t("settings.people.typeToConfirm", { phrase: FORGET_ALL_PHRASE })}
            </label>
            <Input
              id={confirmId}
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        ) : null}
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
            disabled={busy || preview === null || !confirmed}
            onClick={run}
          >
            {all ? t("settings.people.forgetAllConfirm") : t("settings.people.deleteSourceConfirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const row = "flex min-h-9 items-center gap-3";

/** The blocklist editor: entries with Unblock, and a row to block an address, phone or domain. */
function Blocklist({ disabled }: { disabled: boolean }): ReactElement {
  const call = useCall();
  const list = useGatewayQuery("memory.graph.blocklist.list", {});
  const kindId = useId();
  const valueId = useId();
  const [kind, setKind] = useState<BlockKind>("email");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const entries = list.data?.entries ?? [];
  const act = (work: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    work()
      .then(() => {
        after?.();
        list.reload();
      })
      .catch((err: unknown) => toast.error(t("people.writeFailed", { reason: describeError(err) })))
      .finally(() => setBusy(false));
  };
  return (
    <Group title={t("settings.people.blocked")} description={t("settings.people.blockedHint")}>
      {entries.length === 0 ? (
        <p className="text-body text-label-secondary">{t("settings.people.noneBlocked")}</p>
      ) : (
        entries.map((e) => (
          <div key={e.id} className={row}>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body text-label-primary">
                {e.hint ?? t(`settings.people.blockKind.${e.kind}`)}
              </span>
              <span className="text-callout text-label-secondary">
                {t("settings.people.blockedOn", {
                  kind: t(`settings.people.blockKind.${e.kind}`),
                  date: formatDate(e.createdAt),
                })}
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={t("settings.people.unblockLabel", { hint: e.hint ?? "" })}
              onClick={() => act(() => call("memory.graph.blocklist.remove", { id: e.id }))}
            >
              {t("settings.people.unblock")}
            </Button>
          </div>
        ))
      )}
      <form
        className={`${row} flex-wrap`}
        onSubmit={(ev) => {
          ev.preventDefault();
          const v = value.trim();
          if (v === "") return;
          act(
            () => call("memory.graph.blocklist.add", { kind, value: v }),
            () => setValue(""),
          );
        }}
      >
        <label htmlFor={kindId} className="sr-only">
          {t("settings.people.blockKindLabel")}
        </label>
        <NativeSelect
          id={kindId}
          size="sm"
          value={kind}
          disabled={disabled}
          onChange={(e) => {
            const next = BLOCK_KINDS.find((k) => k === e.target.value);
            if (next) setKind(next);
          }}
        >
          {BLOCK_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`settings.people.blockKind.${k}`)}
            </option>
          ))}
        </NativeSelect>
        <label htmlFor={valueId} className="sr-only">
          {t("settings.people.blockValue")}
        </label>
        <Input
          id={valueId}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t(`settings.people.blockPlaceholder.${kind}`)}
          className="h-7 min-w-40 flex-1"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={disabled || busy || value.trim() === ""}
        >
          {t("settings.people.block")}
        </Button>
      </form>
    </Group>
  );
}

export interface PeoplePrivacyProps {
  status: GraphStatus | null;
  /** After a delete: reload the status and the setting (the Gateway turned things off). */
  onChanged: () => void;
}

/** Connected: blocklist, delete by source, forget everything. */
export function PeoplePrivacy({ status, onChanged }: PeoplePrivacyProps): ReactElement {
  const [target, setTarget] = useState<Target | null>(null);
  const withData = (status?.sources ?? []).filter((s) => s.entities > 0 || s.interactions > 0);
  return (
    <>
      <Blocklist disabled={false} />

      <Group
        title={t("settings.people.deleteBySource")}
        description={t("settings.people.deleteBySourceHint")}
      >
        {withData.length === 0 ? (
          <p className="text-body text-label-secondary">{t("settings.people.nothingStored")}</p>
        ) : (
          withData.map((s) => (
            <div key={s.source} className={row}>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-body text-label-primary">
                  {t(`settings.people.source.${s.source}`)}
                </span>
                <span className="text-callout text-label-secondary">
                  {t("settings.people.sourceStored", {
                    entities: s.entities,
                    interactions: s.interactions,
                  })}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-danger-text"
                aria-label={t("settings.people.deleteSourceLabel", {
                  source: t(`settings.people.source.${s.source}`),
                })}
                onClick={() => setTarget({ kind: "source", source: s.source })}
              >
                {t("settings.people.deleteSource")}
              </Button>
            </div>
          ))
        )}
      </Group>

      <Group
        title={t("settings.people.forgetAll")}
        description={t("settings.people.forgetAllHint")}
      >
        <div>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => setTarget({ kind: "all" })}
          >
            {t("settings.people.forgetAllButton")}
          </Button>
        </div>
      </Group>

      <DeleteDialog
        target={target}
        onOpenChange={(open) => !open && setTarget(null)}
        onDone={onChanged}
      />
    </>
  );
}
