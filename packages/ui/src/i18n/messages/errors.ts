/**
 * The Gateway's error codes (`packages/protocol/src/errors.ts`) as sentences the UI can show.
 * `describeError` picks these by code; the Gateway's own English message is kept as the detail
 * while the message locale is English (docs/guides/translating.md "Gateway errors").
 */
export const errors = {
  "errors.not_implemented": "This version of Psyche can't do that yet.",
  "errors.invalid_frame": "Psyche couldn't read the request.",
  "errors.invalid_params": "Some of the values aren't valid.",
  "errors.unknown_method":
    "This version of Psyche doesn't know that request; it may need an update.",
  "errors.protocol_version_mismatch":
    "This app and Psyche's service are different versions; update Psyche.",
  "errors.unauthorized": "This device isn't signed in to Psyche.",
  "errors.forbidden": "This device isn't allowed to do that.",
  "errors.not_paired": "This device isn't paired with Psyche.",
  "errors.pairing_pending": "Pairing is waiting for approval on another device.",
  "errors.origin_rejected": "Psyche refused this page's address.",
  "errors.not_found": "It no longer exists.",
  "errors.conflict": "Something else changed it first; try again.",
  "errors.idempotency_conflict": "That request was already sent with different values.",
  "errors.rate_limited": "Too many requests; wait a moment and try again.",
  "errors.timeout": "Psyche took too long to answer.",
  "errors.cancelled": "It was cancelled.",
  "errors.unavailable": "Psyche can't do that right now.",
  "errors.approval_required": "This needs your approval first.",
  "errors.approval_expired": "The approval expired; ask again.",
  "errors.approval_invalidated": "The approval no longer matches what would happen; ask again.",
  "errors.approval_not_armed": "Hold to approve isn't ready yet.",
  "errors.answer_late": "The answer came after the question closed.",
  "errors.answer_replayed": "That answer was already used.",
  "errors.binding_mismatch": "The approval was for a different action.",
  "errors.taint_blocked": "Blocked: untrusted content can't trigger this.",
  "errors.policy_denied": "Your permission settings don't allow this.",
  "errors.internal": "Something went wrong inside Psyche.",
  "errors.user_in_control":
    "You're using that browser tab; the agent waits until you hand it back.",
  "errors.debugger_detached": "The browser tab disconnected.",
  "errors.tab_not_found": "That browser tab is closed.",
  "errors.method_not_allowed": "The browser doesn't allow that action.",
  "errors.presence_required": "Confirm it's you on a passkey or the Mac helper first.",
  "errors.presence_unavailable_here":
    "Approving this needs someone at the computer. Sign in to its desktop and try again.",
  "errors.presence_agent_missing":
    "This desktop has no password prompt running, so it can't confirm it's you.",
  "errors.presence_policy_missing":
    "This computer isn't set up to confirm it's you yet. Install Psyche's approval policy and try again.",
  "errors.presence_not_enforced":
    "This computer would approve without asking for a password, so it can't confirm it's you.",
  "errors.offline": "Psyche isn't reachable.",
  "errors.unknown": "Something went wrong.",
  // A more specific sentence for a code, chosen by the Gateway's `details.reason` (describeError).
  "errors.reason.vault_removal_pending":
    "Unlock the vault to finish removing the old server, then try again.",
  "errors.reason.connected_with_other_client":
    "Google is connected with another client. Disconnect Google first, then change the client.",
  "errors.reason.secret_required": "A different client needs its own client secret.",
  "errors.reason.project_private":
    "That project is Keep private, so it can't have a Space. Turn off Keep private first.",
  "errors.reason.model_budget":
    "Too many requests from this device. Try again in {minutes, plural, one {# minute} other {# minutes}}.",
  "errors.reason.updating":
    "Psyche is about to restart to install an update. Try again in a moment.",
  "errors.reason.space_main_chat":
    "An automation in a Space can't run in the main chat. Run it in its own chat, or take it out of the Space.",
  "errors.reason.passkey_required": "Set up a passkey to approve payments on this Psyche.",
  "errors.reason.awaiting_owner":
    "An app has unsaved changes. Psyche waits for you to decide what happens to them.",
  "errors.reason.checkout_needs_desktop":
    "Paying in Psyche's browser needs the Psyche desktop app connected to this Host.",
  "errors.reason.permission_missing":
    "Psyche Helper doesn't have the macOS permission for this yet. Allow it in System Settings → Privacy & Security, then try again.",
  "errors.reason.permission_denied":
    "Psyche Helper isn't allowed to do this. Turn it on in System Settings → Privacy & Security, then try again.",
  "errors.reason.automation_denied":
    "Psyche Helper isn't allowed to control this app. Turn it on in System Settings → Privacy & Security → Automation, then try again.",
  "errors.reason.automation_not_granted":
    "Psyche Helper isn't allowed to control this app yet. Try again and choose OK when macOS asks.",
  "errors.reason.full_disk_access_missing":
    "Psyche Helper needs Full Disk Access to read Messages. Turn it on in System Settings → Privacy & Security → Full Disk Access, then restart Psyche Helper.",
  "errors.reason.prompt_refused_by_macos":
    "macOS didn't show the permission prompt. Allow Psyche Helper in System Settings → Privacy & Security instead.",
  "errors.reason.app_not_running": "That app isn't open. Open it, then try again.",
  "errors.reason.needs_helper":
    "This needs Psyche Helper, which isn't running. Restart it in Settings → Devices.",
  "errors.reason.apple_not_connected":
    "Apple apps aren't connected yet. Connect them in Settings → Connectors.",
  "errors.reason.no_folder_shared": "No folder is shared yet. Share one in Settings → File access.",
  "errors.reason.memory_opening": "Memory is still opening. Try again in a moment.",
  "errors.reason.outlook_object_model_guard":
    "Outlook blocks other programs from reading mail or sending, because Windows reports no up-to-date antivirus. Turn on Windows Security, or set Programmatic Access to “Never warn me” in Outlook → File → Options → Trust Center, then try again.",
  "errors.reason.no_chromium":
    "Psyche's browser needs Chromium on this Host. Install it, or set PSYCHE_CHROMIUM.",
  "errors.reason.chromium_sandbox":
    "Chromium's sandbox could not start on this Host, so Psyche's browser is off. Allow Chromium to use user namespaces (an AppArmor profile).",
} as const;
