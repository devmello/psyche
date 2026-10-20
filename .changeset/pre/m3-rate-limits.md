---
"@psyche/channels": minor
"@psyche/connectors": minor
"@psyche/gateway": minor
---

Security §10 rate limits: inbound chat 30/minute per sender (`ChannelServiceOptions.admitInbound`) and `web_fetch` 60/minute per Task (`WebFetchFactoryOptions.beforeFetch`), configurable with `gateway.rateLimits` and audited as `rate_limit.exceeded`.
