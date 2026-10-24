import { useMemo } from "react";
import type { AvatarState } from "../avatar/Avatar.tsx";
import { useApprovals, useQuestions, useStoreState, useTasks } from "../data/index.ts";
import { t } from "../i18n/core.ts";

export interface AgentStatus {
  state: AvatarState;
  /** One-line snippet of current work (UI design §2.3). */
  snippet: string;
  running: number;
  needsYou: number;
  /** Task whose work the snippet describes, if any. */
  taskId: string | null;
}

/**
 * The avatar's state is derived from Tasks, approvals, questions and the Gateway connection,
 * never set by the model (UI design §4.7).
 */
export function useAgentStatus(
  options: { incognito?: boolean; paused?: boolean } = {},
): AgentStatus {
  // Load what the state is derived from (each loader also refreshes after gaps and reconnects).
  useTasks();
  useApprovals();
  useQuestions();
  const connection = useStoreState((s) => s.connection);
  const tasks = useStoreState((s) => s.tasks);
  const approvals = useStoreState((s) => s.approvals);
  const questions = useStoreState((s) => s.inputRequests);
  // A chat turn in progress counts as work too (#555), not only background Tasks: a run the
  // store has seen running, or a thread whose transcript writer is still held.
  const chatRunning = useStoreState(
    (s) =>
      Object.values(s.runs).some((r) => r.status === "running") ||
      Object.values(s.threads).some((th) => {
        const active = th.thread.activeWriterRunId ?? null;
        if (active === null) return false;
        const run = s.runs[active];
        return run === undefined || run.status === "running";
      }),
  );
  const { incognito = false, paused = false } = options;
  return useMemo(() => {
    const list = Object.values(tasks).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const running = list.filter((t) => t.status === "running" || t.status === "queued");
    const pendingApprovals = Object.values(approvals).filter((a) => a.status === "pending").length;
    const openQuestions = Object.values(questions).filter((q) => q.status === "open").length;
    const needsYou = pendingApprovals + openQuestions;
    const latest = list[0];
    const current = running[0];
    const step = current?.checklist.find((c) => c.status === "in_progress")?.text;

    let state: AvatarState = "idle";
    if (connection !== "open") state = "offline";
    else if (paused) state = "paused";
    else if (needsYou > 0) state = "needs-you";
    else if (latest?.status === "failed") state = "error";
    else if (running.length > 0 || chatRunning) state = "working";
    else if (incognito) state = "incognito";

    const snippet =
      state === "offline"
        ? t("agent.status.offline")
        : needsYou > 0
          ? t("agent.status.needsYou", { n: needsYou })
          : current
            ? (step ?? current.title)
            : chatRunning
              ? t("agent.status.working")
              : latest?.status === "failed"
                ? t("agent.status.failed", { title: latest.title })
                : t("agent.status.idle");
    return {
      state,
      snippet,
      running: running.length,
      needsYou,
      taskId: current?.id ?? latest?.id ?? null,
    };
  }, [connection, tasks, approvals, questions, incognito, paused, chatRunning]);
}
