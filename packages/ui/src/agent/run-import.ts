import type { useCall } from "../data/index.ts";
import { describeError } from "../i18n/errors.ts";
import type { ImportRequest, ImportStage, ImportSummary } from "./ImportDialog.tsx";
import { splitExport } from "./split-export.ts";

type Call = ReturnType<typeof useCall>;

/**
 * Runs an import. Memories first, then the conversations in batches (a frame is 1 MiB). A failed
 * step is kept in the summary, not thrown: what was imported before it stays, memories and batch
 * errors are tracked apart, and a failed memory step does not skip the conversations. A retry
 * passes `memoriesImported` to skip the memories it already brought in.
 */
export async function runImport(
  call: Call,
  req: ImportRequest,
  onStage: (stage: ImportStage) => void,
  onProgress: (done: number, total: number) => void,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    memories: 0,
    threads: 0,
    duplicates: 0,
    skipped: [],
    skippedMore: 0,
  };
  if (req.memoriesImported !== undefined) {
    summary.memories = req.memoriesImported;
    summary.memoriesDone = true;
  } else if (req.memories !== undefined) {
    onStage("memories");
    try {
      const res = await call("memory.import", { format: req.source, content: req.memories });
      summary.memories = res.claims.length;
      summary.memoriesDone = true;
    } catch (err) {
      summary.memoriesError = describeError(err);
    }
  }
  if (req.mode === "both" && req.conversations !== undefined) {
    onStage("conversations");
    const split = splitExport(req.conversations);
    summary.skipped.push(...split.skipped);
    summary.batchesDone = 0;
    summary.batchesTotal = split.batches.length;
    onProgress(0, split.batches.length);
    for (const batch of split.batches) {
      try {
        const res = await call("threads.import", { format: req.source, content: batch });
        summary.threads += res.imported;
        summary.duplicates += res.duplicates;
        summary.skipped.push(...res.skipped);
        summary.skippedMore += res.skippedMore;
      } catch (err) {
        // What the earlier batches brought in stays; importing again skips it and carries on.
        summary.error = describeError(err);
        break;
      }
      summary.batchesDone += 1;
      onProgress(summary.batchesDone, split.batches.length);
    }
  }
  return summary;
}
