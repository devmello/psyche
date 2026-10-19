import { getDevice, type PsycheDb } from "@psyche/db";
import type { Caller, PermissionHandlers } from "@psyche/permissions";
import {
  type ApprovalRequest,
  type InputRequest,
  type MethodParams,
  PsycheError,
  type Surface,
} from "@psyche/protocol";
import type { SqliteTaskEngine } from "@psyche/tasks";
import type { Call, HandlerDef } from "../context.ts";
import type { ApprovalTokens } from "./approval-tokens.ts";

/**
 * Adapters from the package handler maps (`(params)` or `(params, caller)`) to the Gateway's
 * `HandlerDef`. The Gateway has already validated params and checked the method's scope.
 */

type ParamsOnly = Record<string, (params: never) => Promise<unknown>>;

/** `memory.*`, `tasks.*`, `automations.*`, `notifications.*`: the handlers take params only. */
export function mountParamsOnly(handlers: ParamsOnly): Record<string, HandlerDef> {
  const out: Record<string, HandlerDef> = {};
  for (const [name, fn] of Object.entries(handlers)) {
    out[name] = { run: (_call: Call, params: never) => fn(params) };
  }
  return out;
}

/**
 * The approval surface a device answers for. Approvals are issued for `desktop` and `web`; a phone
 * or other client gets its own surface name and therefore no token (security §3.7).
 */
export function surfaceOf(db: PsycheDb, deviceId: string): Surface {
  const platform = getDevice(db, deviceId)?.platform;
  if (platform === "macos") return "desktop";
  if (platform === "web") return "web";
  return `device:${platform ?? "unknown"}`;
}

/** `approvals.*`, `grants.*` (and `audit.*` once the protocol has it): caller from the connection. */
export function mountPermissions(
  db: PsycheDb,
  handlers: PermissionHandlers,
  tokens: ApprovalTokens,
): Record<string, HandlerDef> {
  const out: Record<string, HandlerDef> = {};
  for (const [name, fn] of Object.entries(handlers) as [
    string,
    (p: unknown, c: Caller) => Promise<unknown>,
  ][]) {
    // `audit.*` is not in the protocol yet (docs/status/s05.md); the Gateway refuses unknown names.
    if (name.startsWith("audit.")) continue;
    out[name] = {
      async run(call: Call, params: never) {
        const surface = surfaceOf(db, call.identity.deviceId);
        const result = await fn(params, {
          deviceId: call.identity.deviceId,
          scopes: call.identity.scopes,
          surface,
          role: call.identity.role,
        });
        return withAnswerTokens(name, result, surface, tokens);
      },
    };
  }
  return out;
}

/** Adds the caller's own surface token to `approvals.get` / `approvals.list` (security §3.7). */
function withAnswerTokens(
  method: string,
  result: unknown,
  surface: Surface,
  tokens: ApprovalTokens,
): unknown {
  if (method === "approvals.get") {
    const r = result as { approval: ApprovalRequest };
    const token =
      r.approval.status === "pending" ? tokens.tokenFor(r.approval.id, surface) : undefined;
    return token === undefined ? r : { ...r, answerToken: token };
  }
  if (method === "approvals.list") {
    const r = result as { approvals: ApprovalRequest[]; nextCursor: string | null };
    const answerTokens: Record<string, string> = {};
    for (const a of r.approvals) {
      const token = a.status === "pending" ? tokens.tokenFor(a.id, surface) : undefined;
      if (token !== undefined) answerTokens[a.id] = token;
    }
    return { ...r, answerTokens };
  }
  return result;
}

/** What the composed loop offers for attended questions (concrete `PsycheAgentLoop` extras). */
type QuestionAnswer = Record<string, string | string[]>;

export interface QuestionSource {
  answerQuestion(inputRequestId: string, answer: QuestionAnswer): Promise<InputRequest>;
  openQuestions(threadId?: string): InputRequest[];
}

/**
 * `questions.*`: attended questions park inside the loop's turn; task questions live in the task
 * engine (docs/status/s02.md). An answer goes to whichever holds the request.
 */
export function questionHandlers(
  loop: QuestionSource,
  engine: SqliteTaskEngine,
): Record<string, HandlerDef> {
  const all = (threadId?: string): InputRequest[] => {
    const fromTasks = engine.inputRequests().filter((r) => r.status === "open");
    const attended = loop.openQuestions(threadId);
    const seen = new Set(attended.map((r) => r.id));
    return [...attended, ...fromTasks.filter((r) => !seen.has(r.id))];
  };
  const find = (id: string): InputRequest | undefined =>
    all().find((r) => r.id === id) ?? engine.inputRequests().find((r) => r.id === id);
  return {
    "questions.list": {
      run(_call: Call, p: MethodParams<"questions.list">) {
        const statuses = p.status ?? ["open"];
        const items = [
          // Attended questions belong to chat turns, never to a task.
          ...(p.taskId === undefined ? loop.openQuestions(p.threadId) : []),
          ...engine.inputRequests(p.taskId === undefined ? {} : { taskId: p.taskId }),
        ].filter(
          (r, i, arr) =>
            statuses.includes(r.status) &&
            (p.threadId === undefined || r.threadId === p.threadId) &&
            arr.findIndex((o) => o.id === r.id) === i,
        );
        const limit = p.limit ?? 50;
        return { inputRequests: items.slice(0, limit), nextCursor: null };
      },
    },
    "questions.get": {
      run(_call: Call, p: MethodParams<"questions.get">) {
        const inputRequest = find(p.inputRequestId);
        if (inputRequest === undefined) {
          throw new PsycheError("not_found", `input request ${p.inputRequestId} not found`);
        }
        return { inputRequest };
      },
    },
    "questions.answer": {
      async run(call: Call, p: MethodParams<"questions.answer">) {
        const attended = loop.openQuestions().some((r) => r.id === p.inputRequestId);
        if (attended) {
          return { inputRequest: await loop.answerQuestion(p.inputRequestId, p.answer) };
        }
        const task = engine.inputRequests().find((r) => r.id === p.inputRequestId);
        if (task === undefined) {
          throw new PsycheError("not_found", `input request ${p.inputRequestId} not found`);
        }
        return {
          inputRequest: await engine.answerInput(p.inputRequestId, p.answer, {
            deviceId: call.identity.deviceId,
          }),
        };
      },
    },
  };
}
