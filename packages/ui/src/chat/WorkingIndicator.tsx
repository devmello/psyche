import type { ReactElement } from "react";
import { useStoreState } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { WorkingPulse } from "../motion/index.ts";

/**
 * The tool a running run of this thread is executing right now (the most recently started
 * in-flight call), or null. Read from the `run.updated` / `tool_call.updated` events the Gateway
 * already streams.
 */
export function useRunningTool(threadId: string): string | null {
  return useStoreState((s) => {
    let latest: { tool: string; startedAt: string } | null = null;
    for (const call of Object.values(s.toolCalls)) {
      if (call.status !== "running") continue;
      const run = s.runs[call.runId];
      if (run === undefined || run.threadId !== threadId || run.status !== "running") continue;
      if (latest === null || call.startedAt > latest.startedAt) latest = call;
    }
    return latest?.tool ?? null;
  });
}

/**
 * The status line under the last message while a run works (#548): "Wren is working…" from the
 * moment a message is sent until the run settles, "Running mail_search…" while a tool call is in
 * flight. The shared `WorkingPulse` stops within 5 s, at full opacity (WCAG 2.2.2); under reduced
 * motion it is static and the text alone carries the state.
 */
export function WorkingIndicator({
  persona,
  tool,
}: {
  persona: string;
  tool: string | null;
}): ReactElement {
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="chat-working"
      className="mt-3 flex items-center gap-2 ps-7 text-callout text-label-secondary"
    >
      <WorkingPulse />
      {tool === null
        ? t("chat.thread.working", { name: persona })
        : t("chat.thread.runningTool", { tool })}
    </p>
  );
}
