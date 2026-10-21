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
  "errors.offline": "Psyche isn't reachable.",
  "errors.unknown": "Something went wrong.",
} as const;
