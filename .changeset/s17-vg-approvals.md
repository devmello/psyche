---
"@psyche/speech": minor
"@psyche/gateway": minor
"@psyche/permissions": patch
---

Approvals by voice (V-G G3, #691): within chat's tiers (writes by default, never device-only or Touch ID approvals, deny-only in tainted turns), Psyche reads the broker's summary back, listens for a fixed phrase for 10 s and answers through the broker as the device's own card with scope `once`; the audit entry records `via: "voice"`.
