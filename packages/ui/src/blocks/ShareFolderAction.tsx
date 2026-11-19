import type { ToolCall } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useApproval, useCall, useGatewayQuery } from "../data/index.ts";
import { useRun } from "../data/runs.ts";
import { t } from "../i18n/core.ts";

/**
 * The share button under a file tool's "outside every granted folder" error (feature: fewer
 * folder asks). It calls `files.requestShare`, which raises the normal `folder_access` card with
 * the native picker; nothing is granted here. When the card is approved the row says so, and the
 * tool is not retried: the owner asks again.
 */

/** The read-side file tools; a read-only share helps these (a write needs the tool's own ask). */
const READ_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "search_files",
  "open_document",
]);

/**
 * The folder a file tool was denied, or null for any other call. Read from what the Gateway made
 * of the call, never from text: the permission engine denies a file tool before it runs
 * (`status: "blocked"`, rule `folder:not_granted`, target the path it tried).
 */
export function outsideFolderPath(
  call: Pick<ToolCall, "tool" | "status" | "decisionRule" | "target">,
): string | null {
  if (!READ_TOOLS.has(call.tool)) return null;
  if (call.status !== "blocked" || call.decisionRule !== "folder:not_granted") return null;
  return call.target?.kind === "path" && call.target.value.length > 0 ? call.target.value : null;
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
  // Only an admin device may share (`files.requestShare`); `devices.list` is admin-only too, so
  // it is the way to tell: no answer, no button.
  const admin = useGatewayQuery("devices.list", {}).data !== undefined;
  if (threadId === null || !admin) return null;

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

/** The share button under a file tool the permission engine denied for being outside every granted folder. */
export function ShareFolderForCall({ call }: { call: ToolCall }): ReactElement | null {
  const path = outsideFolderPath(call);
  return path === null ? null : <ShareFolderAction call={call} path={path} />;
}
