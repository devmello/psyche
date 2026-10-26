import type { ApprovalRequestInput, PermissionBroker, Task } from "@psyche/protocol";

/**
 * Approvals a specialist asks for carry its parent context (docs/agent/specialists-2026.md
 * §4.4): `requestedBy.parentRunId` and the `specialist` role, from the job's Task, so the card
 * can say "For {task} · {role} started by {agent} in {thread}". Tiers, expiry and binding are
 * unchanged; other requests pass through as they are.
 */
export function withSpecialistContext<B extends PermissionBroker>(
  broker: B,
  task: (taskId: string) => Promise<Task | undefined>,
): B {
  return new Proxy(broker, {
    get(target, prop, receiver) {
      if (prop === "requestApproval") {
        return async (input: ApprovalRequestInput) => {
          const taskId = input.requestedBy.taskId;
          const spec = taskId == null ? undefined : (await task(taskId))?.specialist;
          if (spec === undefined) return target.requestApproval(input);
          return target.requestApproval({
            ...input,
            requestedBy: {
              ...input.requestedBy,
              ...(spec.parentRunId == null ? {} : { parentRunId: spec.parentRunId }),
              specialist: spec.role,
            },
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
