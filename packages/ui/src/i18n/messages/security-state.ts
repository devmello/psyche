/**
 * The security-records banner and its review panel (docs/design/security-state-integrity-2026.md
 * §7.3): what every device shows after a security change made outside Psyche, and the requests
 * made with `psyched` on the Mac that wait before they apply.
 */
export const securityState = {
  "web.security.banner.changed":
    "Psyche undid a change to its security records that was made outside the app.",
  "web.security.banner.untrusted":
    "Psyche's security records failed their check. Changes that widen access are blocked.",
  "web.security.banner.recovery":
    "{count, plural, one {A security change asked for on this Mac applies on {when} unless you cancel it.} other {# security changes asked for on this Mac are waiting. The next applies on {when}.}}",
  "web.security.banner.notice":
    "{count, plural, one {1 security notice to review.} other {# security notices to review.}}",
  "web.security.review": "Review",
  "web.security.hide": "Hide",
  "web.security.panel.label": "Security records",
  "web.security.alert.changed":
    "A program on this Mac changed {count, plural, one {1 security record} other {# security records}} without going through Psyche. Psyche put {count, plural, one {it} other {them}} back. If you did not do this, check the Mac for unwanted software.",
  "web.security.alert.untrusted":
    "The check of Psyche's security records failed. New devices, security settings and Touch ID approvals are blocked. Review your devices, then run psyched security reseal on the Mac; it applies after 24 hours.",
  "web.security.alert.firstSeal":
    "Psyche now checks its security records ({devices, plural, one {1 paired device} other {# paired devices}}). A change made outside Psyche is undone and shown here. Review your devices once.",
  "web.security.alert.resealed": "Psyche sealed its security records again.",
  "web.security.alert.restored":
    "Psyche started from a restored backup and sealed its security records as they are. If you did not restore a backup, check your devices.",
  "web.security.alert.firstAdmin":
    "A command on this Mac made {name} the first admin device. If that was not you, revoke it in Devices.",
  "web.security.alert.requested": "Asked for on this Mac: {action} Applies on {when}.",
  "web.security.alert.applied": "Applied: {action}",
  "web.security.alert.cancelled": "Cancelled: {action}",
  "web.security.alert.failed": "Could not apply: {action}",
  "web.security.op.devicesApprove": "approve the device {name}.",
  "web.security.op.devicesGrant": "change what {name} may do.",
  "web.security.op.presenceReset":
    "stop requiring Touch ID or a passkey for security changes until a new key is registered.",
  "web.security.op.sealReset": "accept the current security records as they are.",
  "web.security.device": "a device",
  "web.security.change":
    "{change, select, added {Added} modified {Changed} other {Removed}}: {what}",
  "web.security.more": "{count, plural, one {and 1 more} other {and # more}}",
  "web.security.ack": "Mark reviewed",
  "web.security.approveNow": "Approve now",
  "web.security.cancel": "Cancel request",
  "web.security.needsApproval":
    "Approve the card with Touch ID or a passkey, then press the button again.",
  "web.security.failed": "That didn't work: {message}",
} as const;
