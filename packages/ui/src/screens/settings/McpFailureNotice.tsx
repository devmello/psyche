import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import type { MessageId } from "../../i18n/messages/index.ts";
import { SandboxNotice } from "./SandboxNotice.tsx";
import { ErrorNotice } from "./shared.tsx";
import type { McpLaunchFailure, McpState } from "./use-mcp.tsx";

/** The launch failure codes `diagnoseLaunch` (the MCP host) can return; anything else gets the generic step. */
const KNOWN = new Set([
  "no_srt",
  "node_missing",
  "uv_missing",
  "command_not_found",
  "network_blocked",
  "timeout",
  "exited",
  "failed",
]);

export function nextStepFor(failure: string): string {
  const code = KNOWN.has(failure) ? failure : "failed";
  return t(`settings.mcp.fail.${code}` as MessageId);
}

/**
 * "The server did not start", with the real reason: what failed, the next step for that reason,
 * and the server's own last words (stderr tail, exit code) as data. A missing sandbox offers the
 * one-click srt install.
 */
export function McpFailureNotice({
  message,
  failure,
  mcp,
}: {
  message: string;
  failure: McpLaunchFailure | null;
  mcp: Pick<McpState, "reload">;
}): ReactElement {
  if (failure === null) {
    return <ErrorNotice what={message} did={t("settings.skills.nothingChanged")} />;
  }
  const tail = failure.stderr.trim();
  return (
    <div className="flex flex-col gap-2">
      <ErrorNotice what={message} did={nextStepFor(failure.failure)} />
      {failure.failure === "no_srt" ? (
        <SandboxNotice message={t("settings.mcp.kind.commandUnavailable")} onReady={mcp.reload} />
      ) : null}
      {failure.exitCode !== undefined ? (
        <p className="text-callout text-label-secondary">
          {t("settings.mcp.fail.exitCode", { code: failure.exitCode })}
        </p>
      ) : null}
      {tail !== "" ? (
        <details className="rounded-md bg-fill-quaternary px-3 py-2 text-callout">
          <summary className="cursor-default text-label-secondary">
            {t("settings.mcp.fail.output")}
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-caption text-label-primary">
            {tail}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
