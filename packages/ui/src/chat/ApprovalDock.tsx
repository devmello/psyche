import type { ReactElement } from "react";
import { ApprovalCard } from "../blocks/ApprovalCard.tsx";
import { useApprovals, useStoreState } from "../data/index.ts";
import { usePersona } from "../slots.tsx";

/**
 * The approval dock above the composer (UI design §3.3): pending approvals for this thread, newest
 * first, outside the message stream. A new card takes focus unless the user is typing and is
 * announced through a polite live region (§4.11).
 */
export function ApprovalDock({
  threadId,
  mode,
  now,
}: {
  threadId: string;
  mode?: string;
  now?: number;
}): ReactElement | null {
  const { pending, answer } = useApprovals();
  const persona = usePersona();
  const tasks = useStoreState((s) => s.tasks);
  const mine = pending.filter((v) => v.approval.requestedBy.threadId === threadId);
  return (
    <div aria-live="polite" aria-relevant="additions" className="flex flex-col gap-2">
      {mine.length > 0 ? (
        <p className="sr-only">
          {mine.length === 1 ? "1 approval needs you" : `${mine.length} approvals need you`}
        </p>
      ) : null}
      {mine.map((v, i) => {
        const taskId = v.approval.requestedBy.taskId;
        const task = taskId ? tasks[taskId] : undefined;
        return (
          <ApprovalCard
            key={v.approval.id}
            approval={v.approval}
            canAnswer={v.canAnswer}
            stale={v.stale}
            persona={persona.name}
            taskTitle={task?.title ?? null}
            createdFrom={task?.createdFrom ?? null}
            {...(mode === undefined ? {} : { mode })}
            otherSurfaces={v.approval.surfaces.filter((s) => s !== "desktop" && s !== "web")}
            onAnswer={(decision, scope) => answer(v.approval.id, decision, scope)}
            autoFocus={i === 0}
            {...(now === undefined ? {} : { now })}
          />
        );
      })}
    </div>
  );
}
