import type { RunStepError, ToolCall } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useApproval, useCall } from "../data/index.ts";
import { useRun, useRunStep } from "../data/runs.ts";
import { t } from "../i18n/core.ts";

/**
 * The share button under a file tool's "outside every granted folder" error (feature: fewer
 * folder asks). It calls `files.requestShare`, which raises the normal `folder_access` card with
 * the native picker; nothing is granted here. When the card is approved the row says so, and the
 * tool is not retried: the owner asks again.
 */

/** The file tools whose reach `assertGranted` limits (`@psyche/files`). */
const FILE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "search_files",
  "write_file",
  "edit_file",
  "open_document",
  "write_document",
]);

const OUTSIDE = " is outside every granted folder";

/** The folder a file tool could not reach, or null when this error is something else. */
export function outsideFolderPath(
  tool: string,
  error: Pick<RunStepError, "code" | "message"> | undefined,
): string | null {
  if (!FILE_TOOLS.has(tool) || error === undefined || error.code !== "forbidden") return null;
  const at = error.message.lastIndexOf(OUTSIDE);
  if (at <= 0 || at + OUTSIDE.length !== error.message.length) return null;
  return error.message.slice(0, at);
}

type Phase =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "pending"; approvalId: string }
  | { kind: "shared" }
  | { kind: "failed" };

export function ShareFolderAction({
  call,
  path,
}: {
  call: ToolCall;
  path: string;
}): ReactElement | null {
  const threadId = useRun(call.runId).run?.threadId ?? null;
  const callMethod = useCall();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const { approval } = useApproval(phase.kind === "pending" ? phase.approvalId : null);
  if (threadId === null) return null;

  const answered = phase.kind === "pending" ? approval?.status : undefined;
  if (phase.kind === "shared" || answered === "approved") {
    return (
      <p className="ms-6 text-callout text-label-secondary" role="status">
        {t("blocks.toolRun.shared")}
      </p>
    );
  }
  if (phase.kind === "pending" && answered !== "denied" && answered !== "expired") {
    return (
      <p className="ms-6 text-callout text-label-secondary" role="status">
        {t("blocks.toolRun.shareWaiting")}
      </p>
    );
  }
  const share = () => {
    if (phase.kind === "asking") return;
    setPhase({ kind: "asking" });
    callMethod("files.requestShare", { threadId, path, access: "read" }).then(
      (res) =>
        setPhase(
          res.status === "already" || res.approvalId === undefined
            ? { kind: "shared" }
            : { kind: "pending", approvalId: res.approvalId },
        ),
      () => setPhase({ kind: "failed" }),
    );
  };
  return (
    <div className="ms-6 flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="link"
        size="xs"
        className="h-auto p-0"
        disabled={phase.kind === "asking"}
        onClick={share}
      >
        {t("blocks.toolRun.shareFolder")}
      </Button>
      {phase.kind === "failed" ? (
        <span className="text-callout text-danger-text" role="alert">
          {t("blocks.toolRun.shareFailed")}
        </span>
      ) : null}
    </div>
  );
}

/** Loads the failed call's step and shows the share button when its error is the outside-folder one. */
export function ShareFolderForCall({ call }: { call: ToolCall }): ReactElement | null {
  if (call.status !== "failed" || call.stepId === undefined) return null;
  return <ShareFolderLoaded call={call} />;
}

function ShareFolderLoaded({ call }: { call: ToolCall }): ReactElement | null {
  const { detail } = useRunStep(call.runId, call.stepId ?? null);
  const path = outsideFolderPath(call.tool, detail?.step.error);
  return path === null ? null : <ShareFolderAction call={call} path={path} />;
}
