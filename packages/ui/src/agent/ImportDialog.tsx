import { type ReactElement, useId, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { BATCH_BYTES, MAX_EXPORT_BYTES } from "./split-export.ts";

export type ImportSourceName = "claude" | "chatgpt";
export type ImportMode = "memories" | "both";

export interface ImportRequest {
  source: ImportSourceName;
  mode: ImportMode;
  /** The memory export's text; absent when only conversations were chosen. */
  memories?: string;
  /** A retry: the memories were already imported (this many claims), so they are skipped. */
  memoriesImported?: number;
  /** `conversations.json`; present for "Memories and conversations". */
  conversations?: string;
}

export interface ImportSummary {
  memories: number;
  threads: number;
  duplicates: number;
  skipped: { title: string; reason: "too_many" | "too_large" | "empty" | "invalid" }[];
  skippedMore: number;
  /** True once the memory step succeeded. */
  memoriesDone?: boolean;
  /** The memory step failed (the conversations still ran). */
  memoriesError?: string;
  /** A conversation batch failed: what was imported before it is kept in the fields above. */
  error?: string;
  batchesDone?: number;
  batchesTotal?: number;
}

export type ImportStage = "memories" | "conversations";

function skipReason(reason: ImportSummary["skipped"][number]["reason"]): string {
  switch (reason) {
    case "too_many":
      return t("agent.memory.importConv.skipTooMany", { n: 200 });
    case "too_large":
      return t("agent.memory.importConv.skipTooLarge");
    case "empty":
      return t("agent.memory.importConv.skipEmpty");
    case "invalid":
      return t("agent.memory.importConv.skipInvalid");
  }
}

/**
 * Import from claude.ai or ChatGPT: "Memories only" stages memory claims for review as before;
 * "Memories and conversations" also adds the chats as read-only threads marked Imported. The
 * caller does the work (`run`) and reports each stage so the dialog can show progress.
 */
export function ImportDialog({
  open,
  onOpenChange,
  run,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: (
    req: ImportRequest,
    onStage: (stage: ImportStage) => void,
    onProgress: (done: number, total: number) => void,
  ) => Promise<ImportSummary>;
}): ReactElement {
  const id = useId();
  const [source, setSource] = useState<ImportSourceName>("claude");
  const [mode, setMode] = useState<ImportMode>("memories");
  const [memories, setMemories] = useState<File | null>(null);
  const [conversations, setConversations] = useState<File | null>(null);
  const [stage, setStage] = useState<ImportStage | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memoriesCount, setMemoriesCount] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const busy = stage !== null;
  const ready = mode === "memories" ? memories !== null : conversations !== null;

  const start = async () => {
    setError(null);
    setSummary(null);
    setProgress(null);
    const tooBig = [memories, mode === "both" ? conversations : null].find(
      (f) => f !== null && f.size > MAX_EXPORT_BYTES,
    );
    const memoriesTooBig = () =>
      setError(t("agent.memory.importConv.memoriesTooBig", { kb: Math.round(BATCH_BYTES / 1000) }));
    if (memories !== null && memories.size > BATCH_BYTES) {
      memoriesTooBig();
      return;
    }
    if (tooBig) {
      setError(
        t("agent.memory.importConv.tooBig", { mb: Math.round(MAX_EXPORT_BYTES / 1024 / 1024) }),
      );
      return;
    }
    setStage(mode === "both" && memories === null ? "conversations" : "memories");
    try {
      const req: ImportRequest = { source, mode };
      if (memoriesCount !== null) req.memoriesImported = memoriesCount;
      else if (memories !== null) {
        req.memories = await memories.text();
        // Quotes, backslashes and newlines double in the frame: measure the escaped text.
        if (new TextEncoder().encode(JSON.stringify(req.memories)).length > BATCH_BYTES) {
          memoriesTooBig();
          return;
        }
      }
      if (mode === "both" && conversations !== null) req.conversations = await conversations.text();
      const result = await run(req, setStage, (done, total) => setProgress({ done, total }));
      if (result.memoriesDone === true) setMemoriesCount(result.memories);
      setSummary(result);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setStage(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(520px,calc(100vw-2rem))] flex-col gap-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("agent.memory.importConv.title")}</DialogTitle>
          <DialogDescription>{t("agent.memory.importConv.note")}</DialogDescription>
        </DialogHeader>

        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0" disabled={busy}>
          <legend className="mb-1 text-callout text-label-secondary">
            {t("agent.memory.importConv.source")}
          </legend>
          {(["claude", "chatgpt"] as const).map((s) => (
            <label key={s} className="flex items-center gap-2 text-body text-label-primary">
              <input
                type="radio"
                name={`${id}-source`}
                checked={source === s}
                onChange={() => setSource(s)}
              />
              {t(
                s === "claude"
                  ? "agent.memory.importConv.claude"
                  : "agent.memory.importConv.chatgpt",
              )}
            </label>
          ))}
        </fieldset>

        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0" disabled={busy}>
          <legend className="mb-1 text-callout text-label-secondary">
            {t("agent.memory.importConv.mode")}
          </legend>
          <label className="flex items-center gap-2 text-body text-label-primary">
            <input
              type="radio"
              name={`${id}-mode`}
              checked={mode === "memories"}
              onChange={() => setMode("memories")}
            />
            {t("agent.memory.importConv.memoriesOnly")}
          </label>
          <label className="flex items-center gap-2 text-body text-label-primary">
            <input
              type="radio"
              name={`${id}-mode`}
              checked={mode === "both"}
              onChange={() => setMode("both")}
            />
            {t("agent.memory.importConv.both")}
          </label>
        </fieldset>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-callout text-label-secondary">
            {t("agent.memory.importConv.memoriesFile")}
            <input
              type="file"
              accept=".json,.md,.txt"
              disabled={busy}
              onChange={(e) => {
                setMemories(e.target.files?.[0] ?? null);
                setMemoriesCount(null);
              }}
            />
          </label>
          {mode === "both" ? (
            <label className="flex flex-col gap-1 text-callout text-label-secondary">
              {t("agent.memory.importConv.conversationsFile")}
              <input
                type="file"
                accept=".json"
                disabled={busy}
                onChange={(e) => setConversations(e.target.files?.[0] ?? null)}
              />
            </label>
          ) : null}
        </div>

        {stage !== null ? (
          <p role="status" className="m-0 text-callout text-label-secondary">
            {stage === "conversations" && progress !== null
              ? t("agent.memory.importConv.progressCount", {
                  done: progress.done,
                  total: progress.total,
                })
              : t(
                  stage === "memories"
                    ? "agent.memory.importConv.progressMemories"
                    : "agent.memory.importConv.progressConversations",
                )}
          </p>
        ) : null}

        {error !== null ? (
          <p role="alert" className="m-0 text-callout text-danger-text">
            {t("agent.memory.importConv.failed", { reason: error })}
          </p>
        ) : null}

        {summary?.memoriesError !== undefined ? (
          <p role="alert" className="m-0 text-callout text-danger-text">
            {t("agent.memory.importConv.memoriesFailed", { reason: summary.memoriesError })}
          </p>
        ) : null}

        {summary?.error !== undefined ? (
          <p role="alert" className="m-0 text-callout text-danger-text">
            {t("agent.memory.importConv.partial", {
              reason: summary.error,
              done: summary.batchesDone ?? 0,
              total: summary.batchesTotal ?? 0,
            })}
          </p>
        ) : null}

        {summary !== null ? (
          <div role="status" className="flex flex-col gap-1 text-callout text-label-primary">
            {summary.error === undefined && summary.memoriesError === undefined ? (
              <p className="m-0 font-medium">{t("agent.memory.importConv.done")}</p>
            ) : null}
            <p className="m-0">
              {t("agent.memory.importConv.sumMemories", { n: summary.memories })}
            </p>
            {mode === "both" ? (
              <>
                <p className="m-0">
                  {t("agent.memory.importConv.sumThreads", { n: summary.threads })}
                </p>
                {summary.duplicates > 0 ? (
                  <p className="m-0">
                    {t("agent.memory.importConv.sumDuplicates", { n: summary.duplicates })}
                  </p>
                ) : null}
                {summary.skipped.length > 0 ? (
                  <>
                    <p className="m-0">
                      {t("agent.memory.importConv.sumSkipped", {
                        n: summary.skipped.length + summary.skippedMore,
                      })}
                    </p>
                    <ul className="m-0 list-disc ps-5 text-label-secondary">
                      {summary.skipped.slice(0, 20).map((s, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: titles can repeat
                        <li key={i}>
                          {s.title || t("agent.memory.importConv.untitled")}: {skipReason(s.reason)}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t(
              summary === null ? "agent.memory.importConv.cancel" : "agent.memory.importConv.close",
            )}
          </Button>
          {summary === null ||
          summary.error !== undefined ||
          summary.memoriesError !== undefined ? (
            <Button disabled={!ready || busy} onClick={() => void start()}>
              {t(
                busy
                  ? "agent.memory.importConv.working"
                  : summary?.error !== undefined || summary?.memoriesError !== undefined
                    ? "agent.memory.importConv.retry"
                    : "agent.memory.importConv.start",
              )}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
