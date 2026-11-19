import { ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, type ReactElement, useId, useState } from "react";
import { toast } from "sonner";
import { DelayedSkeletons } from "../../components/DelayedSkeleton.tsx";
import { ErrorState, GroupedList, GroupedRow } from "../../components/page.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import { useSettings } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { useSlots } from "../../slots.tsx";
import {
  checkFeedAddress,
  FEED_SOURCES_KEY,
  type FeedAddressProblem,
  type FeedSources,
  hostLabel,
  isWebAddress,
  readFeedSources,
  writeFeedSources,
} from "./feed-sources.ts";

function problemText(problem: FeedAddressProblem): string {
  switch (problem) {
    case "empty":
      return t("screens.feed.sourcesEditor.errEmpty");
    case "invalid":
      return t("screens.feed.sourcesEditor.errInvalid");
    case "scheme":
      return t("screens.feed.sourcesEditor.errScheme");
    case "duplicate":
      return t("screens.feed.sourcesEditor.errDuplicate");
  }
}

interface EditingRow {
  index: number;
  text: string;
  problem: FeedAddressProblem | null;
}

/**
 * The sheet's list, add form and actions. Each change is one `settings.set` of `feed.sources`
 * (the Gateway reads it when it starts and on the next brief; the setting is admin-only, so a
 * device without operator.admin sees the Gateway's refusal here).
 */
function FeedSourcesBody(): ReactElement {
  const { settings, set, loading, error, reload } = useSettings();
  const { openExternal } = useSlots();
  const stored = settings[FEED_SOURCES_KEY];
  const sources = readFeedSources(stored);
  // Stable row keys: the address, numbered when the same address is listed twice.
  const seen = new Map<string, number>();
  const rssRows = sources.rss.map((url, index) => {
    const n = (seen.get(url) ?? 0) + 1;
    seen.set(url, n);
    return { url, index, key: `${url}#${n}` };
  });
  const addId = useId();
  const addErrorId = useId();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [addText, setAddText] = useState("");
  const [addProblem, setAddProblem] = useState<FeedAddressProblem | null>(null);
  const [editing, setEditing] = useState<EditingRow | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);

  if (loading) {
    return (
      <DelayedSkeletons
        label={t("screens.feed.sourcesEditor.loading")}
        className="flex flex-col gap-3"
      >
        <Skeleton className="h-28" />
        <Skeleton className="h-9" />
      </DelayedSkeletons>
    );
  }
  if (error) {
    return (
      <ErrorState
        what={t("screens.feed.sourcesEditor.loadFailed")}
        reason={describeError(error)}
        did={t("screens.feed.editor.nothingChanged")}
        retry={{ onClick: reload }}
      />
    );
  }

  const save = async (next: FeedSources, message: string): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    try {
      await set(FEED_SOURCES_KEY, writeFeedSources(stored, next));
      toast(message);
      return true;
    } catch (err) {
      setActionError(t("screens.feed.sourcesEditor.saveFailed", { reason: describeError(err) }));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: "hackerNews" | "arxiv", on: boolean) => {
    void save({ ...sources, [key]: on }, t("screens.feed.sourcesEditor.saved"));
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    const check = checkFeedAddress(addText, sources.rss);
    if (!check.ok) {
      setAddProblem(check.problem);
      return;
    }
    setAddProblem(null);
    void save(
      { ...sources, rss: [...sources.rss, check.url] },
      t("screens.feed.sourcesEditor.added"),
    ).then((ok) => {
      if (ok) setAddText("");
    });
  };

  const saveEdit = () => {
    if (editing === null) return;
    const check = checkFeedAddress(editing.text, sources.rss, editing.index);
    if (!check.ok) {
      setEditing({ ...editing, problem: check.problem });
      return;
    }
    const rss = sources.rss.map((url, i) => (i === editing.index ? check.url : url));
    void save({ ...sources, rss }, t("screens.feed.sourcesEditor.saved")).then((ok) => {
      if (ok) setEditing(null);
    });
  };

  const confirmRemove = () => {
    if (removing === null) return;
    const rss = sources.rss.filter((_, i) => i !== removing);
    setRemoving(null);
    void save({ ...sources, rss }, t("screens.feed.sourcesEditor.removed"));
  };

  const removingUrl = removing === null ? null : (sources.rss[removing] ?? null);
  const openSource = (url: string) => {
    if (!openExternal || !isWebAddress(url)) return;
    openExternal(url).catch((err: unknown) => {
      toast.error(
        t("screens.feed.sourcesEditor.openFailed", {
          host: hostLabel(url),
          reason: describeError(err),
        }),
      );
    });
  };

  return (
    <div className="flex flex-col gap-5">
      {actionError ? (
        <p role="alert" className="text-body text-label-primary">
          <span className="font-semibold text-danger-text">{actionError}</span>
        </p>
      ) : null}

      <GroupedList
        title={t("screens.feed.sourcesEditor.builtIn")}
        footer={t("screens.feed.sourcesEditor.builtInHint")}
      >
        <GroupedRow
          label={t("screens.feed.sourcesEditor.hackerNews")}
          description={t("screens.feed.sourcesEditor.hackerNewsHint")}
          control={
            <Switch
              aria-label={t("screens.feed.sourcesEditor.hackerNews")}
              checked={sources.hackerNews}
              disabled={busy}
              onCheckedChange={(on: boolean) => toggle("hackerNews", on)}
            />
          }
        />
        <GroupedRow
          label={t("screens.feed.sourcesEditor.arxiv")}
          description={t("screens.feed.sourcesEditor.arxivHint")}
          control={
            <Switch
              aria-label={t("screens.feed.sourcesEditor.arxiv")}
              checked={sources.arxiv}
              disabled={busy}
              onCheckedChange={(on: boolean) => toggle("arxiv", on)}
            />
          }
        />
      </GroupedList>

      <section className="flex flex-col gap-2">
        <GroupedList
          title={t("screens.feed.sourcesEditor.feeds")}
          footer={t("screens.feed.sourcesEditor.feedsHint")}
        >
          {sources.rss.length === 0 ? (
            <GroupedRow label={t("screens.feed.sourcesEditor.empty")} />
          ) : null}
          {rssRows.map(({ url, index, key }) => {
            const host = hostLabel(url);
            if (editing?.index === index) {
              return (
                <GroupedRow
                  key={`edit-${key}`}
                  label={
                    <div className="flex flex-col gap-1">
                      <Input
                        value={editing.text}
                        aria-label={t("screens.feed.sourcesEditor.addLabel")}
                        aria-invalid={editing.problem !== null}
                        aria-describedby={editing.problem ? `${addErrorId}-edit` : undefined}
                        onChange={(e) =>
                          setEditing({ ...editing, text: e.target.value, problem: null })
                        }
                        className="h-7"
                      />
                      {editing.problem ? (
                        <p
                          id={`${addErrorId}-edit`}
                          role="alert"
                          className="text-callout text-danger-text"
                        >
                          {problemText(editing.problem)}
                        </p>
                      ) : null}
                    </div>
                  }
                  control={
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setEditing(null)}
                      >
                        {t("common.cancel")}
                      </Button>
                      <Button type="button" size="sm" disabled={busy} onClick={saveEdit}>
                        {t("common.save")}
                      </Button>
                    </>
                  }
                />
              );
            }
            return (
              <GroupedRow
                key={key}
                label={<span className="text-body text-label-primary">{host}</span>}
                description={
                  <span className="flex flex-col gap-0.5">
                    <span>
                      {t("screens.feed.sourcesEditor.kind")}
                      {isWebAddress(url) ? null : ` · ${t("screens.feed.sourcesEditor.notRead")}`}
                    </span>
                    <span className="break-all">{url}</span>
                  </span>
                }
                control={
                  <>
                    {openExternal && isWebAddress(url) ? (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("screens.feed.sourcesEditor.openLabel", { host })}
                        onClick={() => openSource(url)}
                      >
                        <ExternalLink aria-hidden="true" />
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t("screens.feed.sourcesEditor.editLabel", { host })}
                      onClick={() => setEditing({ index, text: url, problem: null })}
                    >
                      <Pencil aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t("screens.feed.sourcesEditor.removeLabel", { host })}
                      onClick={() => setRemoving(index)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </>
                }
              />
            );
          })}
        </GroupedList>
        <p className="px-1 text-callout text-label-secondary">
          {t("screens.feed.sourcesEditor.fetchNote")}
        </p>
      </section>

      <GroupedList title={t("screens.feed.sourcesEditor.addTitle")}>
        <form onSubmit={add} noValidate className="flex flex-col gap-2 px-3 py-2">
          <label htmlFor={addId} className="text-callout text-label-secondary">
            {t("screens.feed.sourcesEditor.addLabel")}
          </label>
          <div className="flex gap-2">
            <Input
              id={addId}
              type="url"
              inputMode="url"
              value={addText}
              placeholder={t("screens.feed.sourcesEditor.addPlaceholder")}
              aria-invalid={addProblem !== null}
              aria-describedby={addProblem ? addErrorId : undefined}
              onChange={(e) => {
                setAddText(e.target.value);
                setAddProblem(null);
              }}
              className="h-8 min-w-0 flex-1"
            />
            <Button type="submit" size="sm" disabled={busy}>
              <Plus aria-hidden="true" />
              {t("screens.feed.sourcesEditor.add")}
            </Button>
          </div>
          {addProblem ? (
            <p id={addErrorId} role="alert" className="text-callout text-danger-text">
              {problemText(addProblem)}
            </p>
          ) : null}
        </form>
      </GroupedList>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("screens.feed.sourcesEditor.removeTitle", {
                host: removingUrl === null ? "" : hostLabel(removingUrl),
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("screens.feed.sourcesEditor.removeBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmRemove}>
              {t("screens.feed.sourcesEditor.confirmRemove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export interface FeedSourcesSheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * "Sources" from the Feed's header: the owner sees, adds, edits and removes the RSS/Atom feeds the
 * Feed reads, and turns Hacker News and arXiv on or off. An opaque right-hand sheet, like the
 * instructions editor. Opening it reads `settings.get`; every change is one `settings.set`.
 */
export function FeedSourcesSheet({ open, onClose }: FeedSourcesSheetProps): ReactElement {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        data-testid="feed-sources"
        className="gap-0 bg-surface-overlay shadow-elevation-3 data-[side=right]:w-full data-[side=right]:border-0 data-[side=right]:sm:max-w-[480px]"
      >
        <SheetHeader className="px-5 pt-5 pb-3">
          <SheetTitle className="text-title-2 text-label-primary">
            {t("screens.feed.sourcesEditor.title")}
          </SheetTitle>
          <SheetDescription className="text-callout text-label-secondary">
            {t("screens.feed.sourcesEditor.description")}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          <FeedSourcesBody />
        </div>
        <SheetFooter className="flex-row items-center justify-end border-t border-separator px-5 py-3">
          <Button type="button" onClick={onClose}>
            {t("common.done")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
