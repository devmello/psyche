import type { ApprovalKind, GrantScope, SideEffect } from "@psyche/protocol";
import { appleAppAction } from "./apple-apps.ts";

/** Side-effect ranks; a grant never covers a more severe call than it was approved for. */
export const SEVERITY: Record<SideEffect, number> = {
  none: 0,
  read: 1,
  write: 2,
  destructive: 3,
  financial: 4,
};
export const ALL_SCOPES: GrantScope[] = ["once", "task", "site", "session", "always"];

/** Never delivered to chat (architecture §4.6; security §3.7, §9). `destructive` / `financial` too. */
export const DEVICE_ONLY_KINDS: readonly ApprovalKind[] = [
  "credential_fill",
  "exec_host",
  "purchase",
  "pairing",
  "policy_change",
  // A skill is code-adjacent text the agent will follow: installed only from a paired device (T2).
  "skill_install",
  // A script drives an app with the owner's Automation grant; approved on the Mac only (#268).
  "apple_script",
  // The owner picks the folder in the native picker; a chat reply could not.
  "folder_access",
  // Turning a capability on, or opening System Settings, happens on the Mac (§3.13).
  "permission_request",
];

/** `authenticationRequired` on the Mac (security §3.7). */
export const AUTH_KINDS: readonly ApprovalKind[] = [
  "credential_fill",
  "purchase",
  "exec_host",
  "pairing",
  "policy_change",
  "apple_script",
];

/**
 * Whether an approval's card is device-only (never in chat): the device-only kinds, the owner's
 * extra kinds (`approvals.deviceOnly`), and every destructive or financial action (security §3.7).
 */
export function isDeviceOnly(
  kind: ApprovalKind,
  se: SideEffect,
  extraDeviceOnly: readonly ApprovalKind[] = [],
): boolean {
  return (
    DEVICE_ONLY_KINDS.includes(kind) ||
    extraDeviceOnly.includes(kind) ||
    se === "destructive" ||
    se === "financial"
  );
}

export const FILE_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "search_files",
  "delete_file",
  "move_file",
]);
/**
 * The coding helper's tools (V10): their path targets (the repository root, a file in it, a
 * command's cwd) get the same folder check as the file tools.
 */
export const CODE_TOOLS = /^code\.(open|search|read|edit|run|git)$/;
export const NAVIGATION_TOOLS = /^browser\.(navigate|open|new_tab|goto)$/;
export const BROWSER_WRITE_TOOLS =
  /^browser\.(click|type|select|fill|submit|press|drag|upload|key)$/;

/** Minimum side-effect class per tool, whatever the registry declares (design-08, design-20). */
const SIDE_EFFECT_FLOORS: { re: RegExp; floor: SideEffect }[] = [
  { re: /^(purchase|checkout|link\.|payments?\.)/, floor: "financial" },
  { re: /^exec_host$/, floor: "destructive" },
  // Runs code the agent wrote (`connector_test`); `connector_remove` is caught by the delete rule.
  { re: /^connector_test$/, floor: "destructive" },
  { re: /^browser\.submit$/, floor: "destructive" },
  {
    re: /(^|[._])(delete|remove|trash|unsubscribe|revoke|oauth_consent|accept_terms|consent)([._]|$)/,
    floor: "destructive",
  },
  {
    re: /^(schedule|automation\.|task\.start|task\.create|subagent\.spawn|idea\.(create|accept)|goal\.)/,
    floor: "write",
  },
  {
    re: /^computer\.(click|double_click|type|key|scroll|drag|open_app|run_shortcut|applescript|right_click)/,
    floor: "write",
  },
  { re: /^(write_file|edit_file|credentials\.request|memory)$/, floor: "write" },
  // The agent writing its own skills: always a card, whatever the registry declares.
  { re: /^skill_(create|update|delete)$/, floor: "destructive" },
  { re: /^code\.(edit|run)$/, floor: "write" },
  { re: /^browser\.(click|type|select|fill|press|drag|upload|key)$/, floor: "write" },
];

export function effectiveSideEffect(tool: string, declared: SideEffect): SideEffect {
  // Apple app adapters (J6): never weaker than the matrix row, whatever the node declares.
  const apple = appleAppAction(tool);
  let se =
    apple !== undefined && SEVERITY[apple.sideEffect] > SEVERITY[declared]
      ? apple.sideEffect
      : declared;
  for (const { re, floor } of SIDE_EFFECT_FLOORS) {
    if (re.test(tool) && SEVERITY[floor] > SEVERITY[se]) se = floor;
  }
  return se;
}

export function inferApprovalKind(tool: string): ApprovalKind {
  const apple = appleAppAction(tool);
  if (apple !== undefined) return apple.kind;
  if (tool === "exec_host") return "exec_host";
  if (tool === "exec" || tool.startsWith("sandbox.")) return "exec";
  if (tool.startsWith("email.") || tool === "gmail.send") return "send_email";
  if (tool.startsWith("calendar.")) return "calendar_write";
  if (tool.startsWith("messages.") || tool.startsWith("channel.")) return "message_send";
  if (tool === "browser.submit") return "browser_submit";
  if (NAVIGATION_TOOLS.test(tool)) return "new_origin";
  if (tool.startsWith("credentials.")) return "credential_fill";
  if (/^(purchase|checkout|link\.)/.test(tool)) return "purchase";
  if (tool === "write_file" || tool === "edit_file" || tool === "code.edit") return "file_write";
  if (tool === "code.run") return "exec";
  if (tool.startsWith("mcp__")) return "mcp_tool";
  if (tool.startsWith("computer.")) return "computer_action";
  if (tool === "memory") return "memory_protected_write";
  if (tool === "skills.install" || /^skill_(create|update|delete)$/.test(tool))
    return "skill_install";
  if (tool === "exit_plan_mode" || tool === "ExitPlanMode") return "plan_exit";
  // Delegation is a `write` (design-08): it gets its own card, not a generic connector action.
  if (tool === "task.start" || tool === "task.create") return "task_start";
  return "connector_action";
}

/** Scopes a side-effect class / kind may ever be granted (security §3.4). */
export function allowedScopes(
  sideEffect: SideEffect | undefined,
  kind: ApprovalKind,
): GrantScope[] {
  if (kind === "purchase") return ["once"];
  // Financial calls: `once`, or an `always` the owner confirms on the card (§3.4, §3.12).
  if (sideEffect === "financial") return ["once", "always"];
  // Scripts and Shortcuts are approved per exact source / name + input (security §5.4).
  if (
    [
      "pairing",
      "policy_change",
      "plan_exit",
      "skill_install",
      "apple_script",
      "shortcut_run",
      // A push publishes exact commits with the owner's credentials (V10).
      "git_push",
      // A setting is turned on until revoked in Settings, never a grant (§3.13).
      "permission_request",
    ].includes(kind)
  )
    return ["once"];
  // A folder is granted for this conversation (`once`) or kept in Settings until revoked (`always`).
  if (kind === "folder_access") return ["once", "always"];
  if (kind === "credential_fill") return ["once", "site"];
  // Security §5.4: exec_host offers `once` or an `always` bound to exact argv + cwd + binary.
  if (kind === "exec_host") return ["once", "always"];
  if (sideEffect === "destructive") return ["once", "task", "always"];
  return ALL_SCOPES;
}

/** `mcp__<server>__<tool>` → connector matrix key. */
export function mcpConnector(tool: string): { id: string; action: string } | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  return m?.[1] === undefined || m[2] === undefined ? undefined : { id: m[1], action: m[2] };
}
