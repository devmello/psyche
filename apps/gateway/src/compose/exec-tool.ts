import { type AgentToolRegistration, defineTool, type ToolRunContext } from "@psyche/agent-core";
import {
  type CredentialMeta,
  type DecisionContext,
  EXEC_DEFAULT_TIMEOUT_MS,
  type PermissionBroker,
  PLACEHOLDER_PATTERN,
  PsycheError,
  type SandboxRunner,
  type SandboxScope,
  type Target,
} from "@psyche/protocol";
import { buildSecretEnv, type SecretEnv, type Vault } from "@psyche/vault";
import { Type } from "@sinclair/typebox";

/**
 * The agent's `exec` tool (architecture §9, K1–K2): one argv in the task's (or thread's) sandbox
 * container, network `none`, never the host. The loop decides it with the existing `exec` policy
 * before dispatch (security §3.5: argv, cwd, explicit env, executable).
 *
 * An env value that is exactly one `{{cred:slug}}` placeholder becomes `PSYCHE_SECRET_<NAME>` of
 * this one process (security §4.6): each item asks for its own `credential_fill` approval, the
 * vault resolves it with executor `sandbox`, and captured output is masked with the vault's
 * redactor. Plain env values pass as given.
 */

const MAX_TIMEOUT_MS = 30 * 60_000;
const ENV_NAME = "^[A-Z][A-Z0-9_]{0,63}$";
const placeholderOnly = new RegExp(`^${PLACEHOLDER_PATTERN.source}$`);

export interface ExecToolDeps {
  runner: SandboxRunner;
  /**
   * The runner for one call, when commands may run elsewhere than `runner` (a Task whose
   * workspace is the sandbox Mac, L1–L5). Never a fallback: the chosen runner fails on its own.
   */
  runnerFor?(ctx: Pick<ToolRunContext, "taskId" | "threadId">): SandboxRunner;
  vault: Vault;
  broker: PermissionBroker;
  /**
   * Called while a command runs with its scope and decision context, so the egress proxy can
   * decide that sandbox's new origins with the turn's taint; returns the release function.
   */
  track?(scope: SandboxScope, ctx: DecisionContext): () => void;
}

/** The task's sandbox when the call belongs to one, else the thread's. */
export function sandboxScope(ctx: Pick<ToolRunContext, "taskId" | "threadId">): SandboxScope {
  return ctx.taskId === undefined
    ? { kind: "thread", id: ctx.threadId }
    : { kind: "task", id: ctx.taskId };
}

/** The destination an item's secret is bound to; the vault checks it against the bindings. */
function itemTarget(item: CredentialMeta): Target | undefined {
  for (const b of item.bindings) {
    if ("origin" in b && !b.origin.includes("*")) return { kind: "origin", value: b.origin };
    if ("host" in b) return { kind: "origin", value: `https://${b.host}` };
  }
  return undefined;
}

/**
 * The owner's item behind a placeholder. Items the Gateway or a connector owns (model provider
 * keys from `models.setKey`, OAuth tokens) are never filled for the agent: they count as missing,
 * before any approval card the owner could never use is raised.
 */
export function fillableItem(
  items: readonly CredentialMeta[],
  slug: string,
): CredentialMeta | undefined {
  return items.find((m) => m.slug === slug && m.ownerConnectorId === null);
}

async function secretEnv(
  deps: ExecToolDeps,
  ctx: ToolRunContext,
  secrets: [string, string][],
  timeoutMs: number,
): Promise<SecretEnv | undefined> {
  if (secrets.length === 0) return undefined;
  const entries = [];
  let target: Target | undefined;
  const items = await deps.vault.list();
  for (const [name, placeholder] of secrets) {
    const slug = placeholderOnly.exec(placeholder)?.[1] ?? "";
    const item = fillableItem(items, slug);
    const bound = item === undefined ? undefined : itemTarget(item);
    if (item === undefined || bound === undefined) {
      throw new PsycheError("not_found", `no vault item ${slug} with an origin or host binding`);
    }
    if (target !== undefined && target.value !== bound.value) {
      throw new PsycheError("invalid_params", "one command's secrets must share one destination");
    }
    target = bound;
    // Its own card per item (security §4.6), device-only with presence like every fill.
    const issued = await deps.vault.requestFill({
      slug,
      target: bound.value,
      executor: "sandbox",
      requestedBy: {
        runId: ctx.runId,
        taskId: ctx.taskId ?? null,
        threadId: ctx.threadId,
        toolCallId: ctx.callId,
      },
      taint: ctx.taint,
    });
    const id = issued.approval.id;
    if (ctx.mode === "unattended") {
      throw new PsycheError("approval_required", "the secret's fill approval is queued", {
        details: { approvalId: id },
      });
    }
    const done = await deps.broker.awaitDecision(id, ctx.signal);
    if (done.status !== "approved") {
      throw new PsycheError("policy_denied", `the secret's fill approval was ${done.status}`, {
        details: { approvalId: id },
      });
    }
    entries.push({ name, placeholder, approvalId: id });
  }
  return buildSecretEnv({
    broker: deps.vault,
    entries,
    target: target as Target,
    ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
    // #290: the values live for this one command; the vault wipes them after its timeout.
    lease: { timeoutMs },
  });
}

export function execTool(deps: ExecToolDeps): AgentToolRegistration {
  return defineTool({
    name: "exec",
    description:
      "Run one command (an argv array, no shell string) in your sandbox (a container with network off, or the sandbox Mac for a Task set to run there): /workspace persists, never the owner's machine. An env value of exactly {{cred:<item>}} is filled from the vault as PSYCHE_SECRET_<NAME> after the owner approves; its value never comes back.",
    input: Type.Object({
      argv: Type.Array(Type.String({ maxLength: 8192 }), { minItems: 1, maxItems: 256 }),
      cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
      env: Type.Optional(
        Type.Record(Type.String({ pattern: ENV_NAME }), Type.String({ maxLength: 8192 })),
      ),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS })),
    }),
    sideEffect: "write",
    provenanceOut: "untrusted",
    describeCall: (p) => {
      const cwd = p.cwd ?? "/workspace";
      const env = Object.entries(p.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .sort();
      const command = p.argv.join(" ");
      return {
        kind: "exec",
        target: { kind: "command", value: command.slice(0, 1000) },
        summary: `Run \`${command.slice(0, 80)}\` in the sandbox`,
        // Security §3.5 exec fields; placeholders bind as written, never their values.
        bindingFields: { argv: p.argv, cwd, env, executable: p.argv[0], network: "none" },
        grantKey: `exec|${JSON.stringify([p.argv, cwd, env])}`,
      };
    },
    async run(p, ctx) {
      const plain: Record<string, string> = {};
      const secrets: [string, string][] = [];
      for (const [k, v] of Object.entries(p.env ?? {})) {
        if (placeholderOnly.test(v.trim())) secrets.push([k, v.trim()]);
        else if (v.includes("{{cred:")) {
          throw new PsycheError(
            "invalid_params",
            `env ${k}: a placeholder must be the whole value`,
          );
        } else plain[k] = v;
      }
      const scope = sandboxScope(ctx);
      const runner = deps.runnerFor?.(ctx) ?? deps.runner;
      const sandbox = await runner.ensureSandbox(scope);
      const filled = await secretEnv(deps, ctx, secrets, p.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS);
      let result: Awaited<ReturnType<SandboxRunner["exec"]>>;
      const release = deps.track?.(scope, {
        threadId: ctx.threadId,
        runId: ctx.runId,
        ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
        permissionMode: ctx.permissionMode,
        taint: ctx.taint,
        ...(ctx.taint ? { taintSources: [...(ctx.taintSources ?? [])] } : {}),
        ...(ctx.mode === "unattended" ? { unattended: true } : {}),
        ...(ctx.requester === undefined ? {} : { requester: ctx.requester }),
      });
      try {
        result = await runner.exec({
          sandboxId: sandbox.id,
          argv: p.argv,
          cwd: p.cwd ?? sandbox.workspacePath,
          env: { ...plain, ...(filled?.env ?? {}) },
          timeoutMs: p.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS,
          signal: ctx.signal,
          // What the command writes carries the turn's taint (S23 design-07).
          provenance: ctx.taint ? "untrusted" : "trusted",
          ...(ctx.taint ? { taintSources: [...(ctx.taintSources ?? [])] } : {}),
        });
      } finally {
        filled?.dispose();
        release?.();
      }
      const redact = (text: string) => deps.vault.redact(text);
      return {
        output: {
          exitCode: result.exitCode,
          stdout: redact(result.stdout),
          stderr: redact(result.stderr),
          durationMs: result.durationMs,
          truncated: result.truncated,
          timedOut: result.timedOut,
          filesChanged: result.filesChanged,
          outcome: result.outcome,
          ...(filled === undefined ? {} : { secretEnv: filled.names }),
        },
        provenance: result.provenance === "trusted" ? "trusted" : "untrusted",
        ...(result.outcome === "failed" ? { isError: true } : {}),
      };
    },
  });
}
