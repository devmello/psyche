import type { Static } from "@sinclair/typebox";
import { PsycheError } from "../errors.ts";
import { ApprovalsMethods } from "./approvals.ts";
import { AttentionMethods } from "./attention.ts";
import { AuditMethods } from "./audit.ts";
import { AutomationsMethods } from "./automations.ts";
import { BackupMethods } from "./backup.ts";
import { BrowserMethods } from "./browser.ts";
import { ChannelsMethods } from "./channels.ts";
import { ChatMethods } from "./chat.ts";
import { ConnectMethods } from "./connect.ts";
import { ConnectorsMethods } from "./connectors.ts";
import { createValidator, type MethodSpec, type Validator } from "./define.ts";
import { DevicesMethods } from "./devices.ts";
import { DictationMethods } from "./dictation.ts";
import { EventsMethods } from "./events.ts";
import { FilesMethods } from "./files.ts";
import { GrantsMethods } from "./grants.ts";
import { FeedbackMethods, GrowthMethods, LessonsMethods } from "./learning.ts";
import { LibraryMethods } from "./library.ts";
import { LogsMethods } from "./logs.ts";
import { McpMethods } from "./mcp.ts";
import { MemoryMethods } from "./memory.ts";
import { ModelsMethods } from "./models.ts";
import { NodeMethods } from "./node.ts";
import { NodesMethods } from "./nodes.ts";
import { NotificationsMethods } from "./notifications.ts";
import { PasskeysMethods } from "./passkeys.ts";
import { PluginsMethods } from "./plugins.ts";
import { FeedMethods, GoalsMethods, IdeasMethods } from "./proactive.ts";
import { QuestionsMethods } from "./questions.ts";
import { ArtifactsMethods, ReceiptsMethods } from "./receipts.ts";
import { SandboxMethods } from "./sandbox.ts";
import { SearchMethods } from "./search.ts";
import { SettingsMethods } from "./settings.ts";
import { SkillsMethods } from "./skills.ts";
import { TasksMethods } from "./tasks.ts";
import { ThreadsMethods } from "./threads.ts";
import { UsageMethods } from "./usage.ts";
import { VaultMethods } from "./vault.ts";
import { ViewMethods } from "./view.ts";
import { VmMethods } from "./vm.ts";
import { VoiceMethods } from "./voice.ts";

export * from "./approvals.ts";
export * from "./attention.ts";
export * from "./audit.ts";
export * from "./automations.ts";
export * from "./backup.ts";
export * from "./browser.ts";
export * from "./channels.ts";
export * from "./chat.ts";
export * from "./connect.ts";
export * from "./connectors.ts";
export * from "./define.ts";
export * from "./devices.ts";
export * from "./dictation.ts";
export * from "./events.ts";
export * from "./files.ts";
export * from "./grants.ts";
export * from "./learning.ts";
export * from "./library.ts";
export * from "./logs.ts";
export * from "./mcp.ts";
export * from "./memory.ts";
export * from "./models.ts";
export * from "./node.ts";
export * from "./nodes.ts";
export * from "./notifications.ts";
export * from "./passkeys.ts";
export * from "./plugins.ts";
export * from "./proactive.ts";
export * from "./questions.ts";
export * from "./receipts.ts";
export * from "./sandbox.ts";
export * from "./search.ts";
export * from "./settings.ts";
export * from "./skills.ts";
export * from "./tasks.ts";
export * from "./threads.ts";
export * from "./vault.ts";
export * from "./view.ts";
export * from "./vm.ts";
export * from "./voice.ts";

/**
 * Every WS method (wire spec v1). Families are additive: new methods are appended by their
 * owning session through a `protocol:` PR (see CHANGES.md).
 */
export const Methods = {
  ...ConnectMethods,
  ...ThreadsMethods,
  ...ChatMethods,
  ...TasksMethods,
  ...ApprovalsMethods,
  ...GrantsMethods,
  ...MemoryMethods,
  ...McpMethods,
  ...LibraryMethods,
  ...FilesMethods,
  ...SettingsMethods,
  ...SearchMethods,
  ...NotificationsMethods,
  ...NodesMethods,
  ...DevicesMethods,
  ...PasskeysMethods,
  ...ConnectorsMethods,
  ...ChannelsMethods,
  ...AutomationsMethods,
  ...VaultMethods,
  ...ViewMethods,
  ...BrowserMethods,
  ...SandboxMethods,
  ...AuditMethods,
  ...EventsMethods,
  ...NodeMethods,
  ...QuestionsMethods,
  ...ReceiptsMethods,
  ...ArtifactsMethods,
  ...FeedMethods,
  ...IdeasMethods,
  ...GoalsMethods,
  ...VoiceMethods,
  ...VmMethods,
  ...DictationMethods,
  ...AttentionMethods,
  ...SkillsMethods,
  ...PluginsMethods,
  ...BackupMethods,
  ...LogsMethods,
  ...ModelsMethods,
  ...UsageMethods,
  ...FeedbackMethods,
  ...LessonsMethods,
  ...GrowthMethods,
} as const;

export type MethodName = keyof typeof Methods;
export type MethodParams<M extends MethodName> = Static<(typeof Methods)[M]["params"]>;
export type MethodResult<M extends MethodName> = Static<(typeof Methods)[M]["result"]>;

const methodTable: Readonly<Record<string, MethodSpec>> = Methods;

export function isMethodName(s: unknown): s is MethodName {
  return typeof s === "string" && Object.hasOwn(methodTable, s);
}

/** Registry entry for a method; throws `unknown_method` for anything else. */
export function methodSpec<M extends MethodName>(name: M): (typeof Methods)[M];
export function methodSpec(name: string): MethodSpec;
export function methodSpec(name: string): MethodSpec {
  const spec = isMethodName(name) ? methodTable[name] : undefined;
  if (spec === undefined)
    throw new PsycheError("unknown_method", `unknown method ${JSON.stringify(name)}`);
  return spec;
}

const paramValidators = new Map<string, Validator<MethodSpec["params"]>>();
const resultValidators = new Map<string, Validator<MethodSpec["result"]>>();

function validatorFor(
  cache: Map<string, Validator<MethodSpec["params"]>>,
  method: string,
  pick: "params" | "result",
) {
  let v = cache.get(method);
  if (v === undefined) {
    v = createValidator(methodSpec(method)[pick]);
    cache.set(method, v);
  }
  return v;
}

/**
 * Validates a request's params against the method's schema and returns them typed. Absent
 * params count as `{}`. Throws `unknown_method` or `invalid_params` (message lists the first
 * failing paths, e.g. `invalid params for threads.rename: /title: Expected string`).
 */
export function validateParams<M extends MethodName>(method: M, params: unknown): MethodParams<M>;
export function validateParams(method: string, params: unknown): unknown;
export function validateParams(method: string, params: unknown): unknown {
  const value = params === undefined ? {} : params;
  const v = validatorFor(paramValidators, method, "params");
  if (v.check(value)) return value;
  const errors = v.errors(value);
  throw new PsycheError("invalid_params", `invalid params for ${method}: ${errors.join("; ")}`, {
    details: { method, errors },
  });
}

/** Validates a result before it is sent (Gateway tests and debug builds). Throws `internal`. */
export function validateResult<M extends MethodName>(method: M, result: unknown): MethodResult<M>;
export function validateResult(method: string, result: unknown): unknown;
export function validateResult(method: string, result: unknown): unknown {
  const v = validatorFor(resultValidators, method, "result");
  if (v.check(result)) return result;
  const errors = v.errors(result);
  throw new PsycheError("internal", `invalid result for ${method}: ${errors.join("; ")}`, {
    details: { method, errors },
  });
}

/** `true` when the `req` frame for this method must carry `idempotencyKey`. */
export function requiresIdempotencyKey(method: string): boolean {
  return isMethodName(method) && methodTable[method]?.sideEffecting === true;
}
