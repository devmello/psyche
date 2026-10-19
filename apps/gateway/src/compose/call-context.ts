import type { AgentToolRegistration, AgentToolRegistry, ToolRunContext } from "@psyche/agent-core";
import {
  PsycheError,
  type ToolRegistration,
  type ToolRegistry,
  type Unsubscribe,
} from "@psyche/protocol";

/**
 * The decision context of each running tool call, for executors from other packages
 * (browser, connectors). Their `ToolExecutor` receives only `(callId, params, signal)`, but
 * they need the thread, run, task, taint, mode and the approval the loop obtained for the call
 * (S08 `BrowserToolDeps.context`, S09 `ConnectorRegistry` `approvalFor`).
 *
 * `adopt(registry)` returns a `ToolRegistry` whose plain registrations are re-registered as
 * in-process tools: the loop calls `run(params, ctx)`, which records `ctx` for the call id
 * while the package's `execute` runs.
 */
export class CallContexts {
  readonly #calls = new Map<string, ToolRunContext>();

  get(callId: string): ToolRunContext | undefined {
    return this.#calls.get(callId);
  }

  /** The browser's `CallContext` (a `DecisionContext` plus the call's approval). */
  context(callId: string) {
    const ctx = this.#calls.get(callId);
    if (ctx === undefined) {
      throw new PsycheError("internal", `no running tool call ${callId}`);
    }
    return {
      toolCallId: callId,
      threadId: ctx.threadId,
      runId: ctx.runId,
      ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
      permissionMode: ctx.permissionMode,
      taint: ctx.taint,
      ...(ctx.mode === "unattended" ? { unattended: true } : {}),
      ...(ctx.approvalId === undefined ? {} : { approvalId: ctx.approvalId }),
    };
  }

  /** The approval id the broker issued for this call, if it asked. */
  approvalFor(callId: string): string | undefined {
    return this.#calls.get(callId)?.approvalId;
  }

  wrap(registration: ToolRegistration): AgentToolRegistration {
    const execute = registration.execute;
    return {
      ...registration,
      run: async (params, ctx) => {
        this.#calls.set(ctx.callId, ctx);
        try {
          return await execute(ctx.callId, params, ctx.signal, ctx.onUpdate);
        } finally {
          this.#calls.delete(ctx.callId);
        }
      },
    };
  }

  adopt(registry: AgentToolRegistry): ToolRegistry {
    return {
      list: () => registry.list(),
      get: (name: string) => registry.get(name),
      register: (registration: ToolRegistration): Unsubscribe =>
        registry.register(
          "run" in registration && registration.run !== undefined
            ? registration
            : this.wrap(registration),
        ),
    };
  }
}
