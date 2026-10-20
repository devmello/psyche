---
"@psyche/connectors": minor
"@psyche/testing": patch
---

`safeFetch` checks every redirect hop against an `allowHop` policy (`originAllowlist`, canonical origins); `web_fetch` allows the request's origin plus the Task's origin set and refuses other hops with `redirect_not_allowlisted` (#72). The scenario world uses the real check.
