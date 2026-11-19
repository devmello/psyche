/**
 * Deferred approvals (automation digest): an unattended run asks for an action that no owner is
 * there to answer. The card waits in the approvals queue and the Gateway raises one digest for
 * them. This is the one place that says which tasks count as unattended, so the Gateway and the
 * desktop agree on the list.
 */
export interface DeferralTask {
  createdFrom: string;
  specialist?: { parentRunId?: string | null } | null;
}

/** A scheduled or proactive automation, or a specialist one started with no parent run (§4.10). */
export function isUnattendedTask(task: DeferralTask | undefined): boolean {
  if (task === undefined) return false;
  return (
    task.createdFrom === "automation" ||
    (task.createdFrom === "subagent" && task.specialist?.parentRunId === null)
  );
}
