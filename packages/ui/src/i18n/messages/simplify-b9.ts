/**
 * Desktop simplify batch B9: sidebar rows, approval cards and Library labels. New keys only;
 * the old keys stay for the copy sweep.
 */
export const simplifyB9 = {
  "simplify.b9.approval.expiresAt": "Expires at {time}",
  "simplify.b9.execHost.sandboxed": "Runs in the sandbox.",
  "simplify.b9.execHost.noSandbox":
    "The sandbox is not set up, so this command can only run without it. Set it up, or run it without the sandbox this once.",
  "simplify.b9.execHost.noHostSandbox":
    "There is no sandbox for commands on this computer, so this command can only run without one. You can run it this once.",
  "simplify.b9.execHost.runOnce": "Run once without the sandbox",
  "simplify.b9.library.madeBy": "Made by {name}",
  "simplify.b9.library.task": "Task",
  "simplify.b9.library.more": "More filters",
} as const;
