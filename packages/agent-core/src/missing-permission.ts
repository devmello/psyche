import { MissingPermission, PsycheError } from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";

/**
 * Missing permissions (security §3.13): a broker denial or a tool error that names what the
 * owner could grant reaches the model as that object plus one instruction, so the agent asks with
 * `request_permission` instead of giving up. The owner decides on the card; nothing is granted
 * here.
 */

export const REQUEST_PERMISSION_TOOL = "request_permission";

/** `details.missing` of a thrown PsycheError, when it is a well-formed MissingPermission. */
export function missingOf(err: unknown): MissingPermission | undefined {
  if (!(err instanceof PsycheError)) return undefined;
  const m = (err.details as { missing?: unknown } | undefined)?.missing;
  return Value.Check(MissingPermission, m) ? m : undefined;
}

export function missingHint(missing: MissingPermission): string {
  return `Missing permission: ${JSON.stringify(missing)}. Ask the owner with ${REQUEST_PERMISSION_TOOL} ({"need": <that object>, "reason": "<why, in one sentence>"}) and retry only if it is granted.`;
}
