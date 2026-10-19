import type { AgentToolRegistration, AgentToolRegistry, ToolRunContext } from "@psyche/agent-core";
import {
  PsycheError,
  type ToolCallAuthority,
  type ToolRegistration,
  type ToolRegistry,
  type Unsubscribe,
} from "@psyche/protocol";

/**
 * The decision context of each running tool call, for executors from other packages
 * (browser, connectors). Their `ToolExecutor` receives only `(callId, params, signal)`, but
 * they need the thread, run, task, taint, mode and what authorized the call: the approval the
 * loop obtained or the standing grant it verified (S08 `BrowserToolDeps.context`, S09
 * `ConnectorRegistry` `authorityFor`).
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
      ...(ctx.taint ? { taintSources: [...(ctx.taintSources ?? [])] } : {}),
      ...(ctx.mode === "unattended" ? { unattended: true } : {}),
      ...(ctx.approvalId === undefined ? {} : { approvalId: ctx.approvalId }),
      ...(ctx.requester === undefined ? {} : { requester: ctx.requester }),
    };
  }

  /** The approval id the broker issued for this call, if it asked. */
  approvalFor(callId: string): string | undefined {
    return this.#calls.get(callId)?.approvalId;
  }

  /** What authorized this call (approval or standing grant), as the loop verified it. */
  authorityFor(callId: string): ToolCallAuthority | undefined {
    return this.#calls.get(callId)?.authority;
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
