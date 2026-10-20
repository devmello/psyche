import type { ApprovalKind, GrantScope, SideEffect } from "@psyche/protocol";

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
];

/** `authenticationRequired` on the Mac (security §3.7). */
export const AUTH_KINDS: readonly ApprovalKind[] = [
  "credential_fill",
  "purchase",
  "exec_host",
  "pairing",
  "policy_change",
];

export const FILE_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "search_files",
  "delete_file",
  "move_file",
]);
export const NAVIGATION_TOOLS = /^browser\.(navigate|open|new_tab|goto)$/;
export const BROWSER_WRITE_TOOLS =
  /^browser\.(click|type|select|fill|submit|press|drag|upload|key)$/;

/** Minimum side-effect class per tool, whatever the registry declares (design-08, design-20). */
const SIDE_EFFECT_FLOORS: { re: RegExp; floor: SideEffect }[] = [
  { re: /^(purchase|checkout|link\.|payments?\.)/, floor: "financial" },
  { re: /^exec_host$/, floor: "destructive" },
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
  { re: /^browser\.(click|type|select|fill|press|drag|upload|key)$/, floor: "write" },
];

export function effectiveSideEffect(tool: string, declared: SideEffect): SideEffect {
  let se = declared;
  for (const { re, floor } of SIDE_EFFECT_FLOORS) {
    if (re.test(tool) && SEVERITY[floor] > SEVERITY[se]) se = floor;
  }
  return se;
}

export function inferApprovalKind(tool: string): ApprovalKind {
  if (tool === "exec_host") return "exec_host";
  if (tool === "exec" || tool.startsWith("sandbox.")) return "exec";
  if (tool.startsWith("email.") || tool === "gmail.send") return "send_email";
  if (tool.startsWith("calendar.")) return "calendar_write";
  if (tool.startsWith("messages.") || tool.startsWith("channel.")) return "message_send";
  if (tool === "browser.submit") return "browser_submit";
  if (NAVIGATION_TOOLS.test(tool)) return "new_origin";
  if (tool.startsWith("credentials.")) return "credential_fill";
  if (/^(purchase|checkout|link\.)/.test(tool)) return "purchase";
  if (tool === "write_file" || tool === "edit_file") return "file_write";
  if (tool.startsWith("mcp__")) return "mcp_tool";
  if (tool.startsWith("computer.")) return "computer_action";
  if (tool === "memory") return "memory_protected_write";
  if (tool === "skills.install") return "skill_install";
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
  if (sideEffect === "financial" || kind === "purchase") return ["once"];
  if (["pairing", "policy_change", "plan_exit", "skill_install"].includes(kind)) return ["once"];
  if (kind === "credential_fill") return ["once", "site"];
  // Security §5.4: exec_host offers `once` or an `always` bound to exact argv + cwd + binary.
  if (kind === "exec_host") return ["once", "always"];
  if (sideEffect === "destructive") return ["once", "task"];
  return ALL_SCOPES;
}

/** `mcp__<server>__<tool>` → connector matrix key. */
export function mcpConnector(tool: string): { id: string; action: string } | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  return m?.[1] === undefined || m[2] === undefined ? undefined : { id: m[1], action: m[2] };
}
