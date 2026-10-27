import type { MissingPermission, SideEffect } from "@psyche/protocol";
import { SEVERITY } from "./kinds.ts";
import type { PolicyCall } from "./types.ts";

/**
 * The permission a broker denial was missing (security §3.12), for the denials the owner can
 * lift on a `request_permission` card: a folder outside the grants, `exec_host` off, and a
 * connector action group set to deny. Every other denial (prohibitions, deny rules, plan mode,
 * taint) names nothing: the agent cannot ask its way past those.
 */
export function missingFor(
  rule: string,
  call: PolicyCall,
  se: SideEffect,
  fields: Record<string, unknown> | undefined,
): MissingPermission | undefined {
  if (rule === "exec_host:disabled") return { need: "capability", capability: "exec_host" };
  if (rule === "folder:not_granted" || rule === "folder:read_only") {
    const cwd = typeof fields?.cwd === "string" ? fields.cwd : undefined;
    const path = call.tool === "exec_host" ? cwd : call.target?.value;
    if (path === undefined || !path.startsWith("/")) return undefined;
    const write = rule === "folder:read_only" || SEVERITY[se] >= SEVERITY.write;
    return { need: "folder", path, access: write ? "read_write" : "read" };
  }
  const m = /^connector:(.+)\/([^/]+)$/.exec(rule);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    return { need: "connector_action", connector: m[1], group: m[2] };
  }
  return undefined;
}
