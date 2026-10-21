import type { ReactElement } from "react";
import { useStoreState } from "../data/index.ts";
import { t } from "../i18n/core.ts";

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
 * flight. The dots pulse only when motion is allowed; the text alone carries the state.
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
      className="my-2 flex items-center gap-2 ps-7 text-small text-muted-foreground"
    >
      <span className="flex gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 rounded-full bg-gray-9 motion-safe:animate-pulse"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </span>
      {tool === null
        ? t("chat.thread.working", { name: persona })
        : t("chat.thread.runningTool", { tool })}
    </p>
  );
}
