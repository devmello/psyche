import {
  PsycheError,
  type SideEffect,
  type Target,
  type TargetKind,
  type Unsubscribe,
} from "@psyche/protocol";
import { Type } from "@sinclair/typebox";
import { type AgentToolRegistration, defineTool, type ToolRunContext } from "../registry.ts";
import type { TurnToolContext } from "./turn.ts";

/**
 * Harness plugin seam (feature C10; architecture §4.3 "Harness plugins"): run Claude Code,
 * Codex or pi as an embedded harness for a coding session, behind Psyche's own permission and
 * receipt layer. A plugin adapts its harness's approval hook (Claude Agent SDK `canUseTool`,
 * Codex approval policy, pi `beforeToolCall`) to `gate`, so every action the harness wants to
 * take passes the Permission Broker with the same approval cards as a native tool call.
 */

/** One action the harness wants to take, described by the plugin. */
export interface HarnessAction {
  /** The harness's own tool name, e.g. `Bash`, `Edit`, `WebFetch`. */
  tool: string;
  input: unknown;
  /** Classified by the plugin; the loop never treats an unclassified action as harmless. */
  sideEffect: SideEffect;
  targetKind?: TargetKind;
  target?: Target;
  summary: string;
}

export type HarnessGateResult =
  | { allowed: true; actionId: string; approvalId?: string }
  | { allowed: false; actionId: string; reason: string };

export interface HarnessRunContext {
  /** Working folder the session is scoped to (a granted folder or a sandbox path). */
  cwd: string;
  brief: string;
  signal: AbortSignal;
  /** Ask Psyche before every action; resolves after any approval wait. Deny means do not run it. */
  gate(action: HarnessAction): Promise<HarnessGateResult>;
  /** Report what an allowed action did; write+ actions get a receipt. */
  actionDone(
    actionId: string,
    outcome: "ok" | "failed" | "uncertain",
    summary?: string,
  ): Promise<void>;
  /** Progress line for the transcript. */
  progress(message: string): void;
}

export interface HarnessRunResult {
  /** Final report of the session (untrusted: the harness read code, docs and the web). */
  report: string;
  outcome: "completed" | "failed" | "cancelled";
  /** Harness-native session id, for resuming. */
  sessionId?: string;
}

export interface HarnessPlugin {
  /** Short id, e.g. `claude-code`, `codex`, `pi`. */
  id: string;
  name: string;
  /** Installed and configured on this machine. */
  available(): Promise<boolean>;
  run(ctx: HarnessRunContext): Promise<HarnessRunResult>;
}

export class HarnessRegistry {
  #plugins = new Map<string, HarnessPlugin>();

  register(plugin: HarnessPlugin): Unsubscribe {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(plugin.id)) {
      throw new PsycheError("invalid_params", `invalid harness id ${plugin.id}`);
    }
    if (this.#plugins.has(plugin.id)) {
      throw new PsycheError("conflict", `harness ${plugin.id} already registered`);
    }
    this.#plugins.set(plugin.id, plugin);
    return () => {
      if (this.#plugins.get(plugin.id) === plugin) this.#plugins.delete(plugin.id);
    };
  }

  get(id: string): HarnessPlugin | undefined {
    return this.#plugins.get(id);
  }

  list(): { id: string; name: string }[] {
    return [...this.#plugins.values()].map((p) => ({ id: p.id, name: p.name }));
  }
}

/** What the loop lends `harness.delegate`: the gate and receipt path of the calling run. */
export interface HarnessTurnApi {
  gateHarnessAction(
    harnessId: string,
    callId: string,
    action: HarnessAction,
  ): Promise<HarnessGateResult>;
  harnessActionDone(
    actionId: string,
    outcome: "ok" | "failed" | "uncertain",
    summary?: string,
  ): Promise<void>;
}

export function harnessDelegateTool(harnesses: HarnessRegistry): AgentToolRegistration {
  return defineTool({
    name: "harness.delegate",
    description:
      "Delegate a coding task to an installed coding harness (for example Claude Code or Codex). Every action it takes asks Psyche's permissions first; you get its report back.",
    input: Type.Object(
      {
        harness: Type.String({ minLength: 1, maxLength: 32 }),
        cwd: Type.String({
          minLength: 1,
          maxLength: 1_024,
          description: "Granted folder to work in",
        }),
        brief: Type.String({ minLength: 1, maxLength: 16_000 }),
      },
      { additionalProperties: false },
    ),
    // Starting a session is itself a write: it spends resources and acts in a folder.
    sideEffect: "write",
    targetKind: "path",
    provenanceOut: "untrusted",
    describeCall: (p) => ({
      target: { kind: "path", value: p.cwd },
      summary: `Delegated to ${p.harness}`,
    }),
    run: async (p, ctx: ToolRunContext) => {
      const plugin = harnesses.get(p.harness);
      if (plugin === undefined) {
        throw new PsycheError(
          "not_found",
          `no harness ${p.harness}; installed: ${
            harnesses
              .list()
              .map((h) => h.id)
              .join(", ") || "none"
          }`,
        );
      }
      if (!(await plugin.available())) {
        throw new PsycheError("unavailable", `${plugin.name} is not available on this machine`);
      }
      const turn = (ctx as Partial<TurnToolContext>).turn as
        | (TurnToolContext["turn"] & Partial<HarnessTurnApi>)
        | undefined;
      if (turn?.gateHarnessAction === undefined || turn.harnessActionDone === undefined) {
        throw new PsycheError("internal", "harness.delegate runs inside the agent loop");
      }
      const gate = turn.gateHarnessAction;
      const done = turn.harnessActionDone;
      const result = await plugin.run({
        cwd: p.cwd,
        brief: p.brief,
        signal: ctx.signal,
        gate: (action) => gate(plugin.id, ctx.callId, action),
        actionDone: (id, outcome, summary) => done(id, outcome, summary),
        progress: (message) => ctx.onUpdate({ message }),
      });
      return {
        output: {
          harness: plugin.id,
          outcome: result.outcome,
          report: result.report,
          ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
        },
        ...(result.outcome === "completed" ? {} : { isError: true }),
        provenance: "untrusted",
      };
    },
  });
}
