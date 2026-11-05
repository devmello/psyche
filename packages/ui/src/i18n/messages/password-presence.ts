/** Password presence on Linux (linux design §9): the approval card, Settings → Devices. */
export const passwordPresence = {
  "blocks.approval.password.needsAuth": "Needs your password or a passkey to approve.",
  "blocks.approval.password.waiting": "Type your password in the system dialog to approve {code}",
  "blocks.approval.password.waitingShort": "Waiting for your password…",
  "blocks.approval.password.onceOnly": "Password approvals from this window are once only.",
  "blocks.approval.status.allowedOncePassword":
    "Allowed once (password approvals from this window are once only)",
  "blocks.approval.password.noUnsandboxed":
    "Running a command without the sandbox can't be approved with a password from this window. Set up the sandbox instead",
  "blocks.approval.password.cancelled":
    "The password dialog was cancelled, so nothing was approved",
  "blocks.approval.password.failed":
    "The password wasn't accepted, so nothing was approved. Try again.",
  "blocks.approval.password.unavailableHere":
    "Approve at this computer, or with a passkey from another device.",
  "blocks.approval.password.agentMissing":
    "No password dialog is available on this desktop. Install a polkit agent such as polkit-gnome or lxpolkit, or use a passkey.",
  "blocks.approval.password.policyMissing":
    "Psyche's password policy isn't installed on this computer. Run Psyche's one-time setup, or use a passkey.",
  "blocks.approval.password.notEnforced":
    "A polkit rule on this computer approves Psyche without a password, so it can't confirm it was you. Remove the rule, or use a passkey.",
  "blocks.approval.password.unreachable":
    "The system's password service isn't available. Try again, or use a passkey.",
  "settings.devices.password.title": "Password approvals",
  "settings.devices.password.description":
    "Before a sensitive action is approved, Psyche asks for your password in the system's own dialog. The password never goes to Psyche.",
  "settings.devices.password.state.ready": "Ready",
  "settings.devices.password.state.policyMissing": "Policy not installed",
  "settings.devices.password.state.notEnforced": "Off",
  "settings.devices.password.state.noSession": "No desktop session",
  "settings.devices.password.state.agentMissing": "No password dialog",
  "settings.devices.password.state.unavailable": "Unavailable",
  "settings.devices.password.detail.ready":
    "Psyche asks for your password in the system dialog when you approve a sensitive action.",
  "settings.devices.password.detail.policyMissing":
    "Psyche's password policy isn't installed on this computer. Run Psyche's one-time setup.",
  "settings.devices.password.detail.notEnforced":
    "A polkit rule on this computer approves Psyche without a password. Password approvals are off until it's removed.",
  "settings.devices.password.detail.noSession":
    "Password approvals need an active desktop session on this computer. Open Psyche there.",
  "settings.devices.password.detail.agentMissing":
    "No password dialog is available on this desktop. Install a polkit agent such as polkit-gnome or lxpolkit.",
  "settings.devices.password.detail.unavailable":
    "Psyche couldn't reach the system's password service.",
  "settings.devices.password.x11Warning":
    "This is an X11 session. Other programs can read what you type here, so a password is a speed bump, not a boundary. A Wayland session is safer.",
} as const;
