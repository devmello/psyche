---
"@psyche/model-router": patch
---

Tool input schemas (#414): a top-level `anyOf` / `oneOf` / `allOf` of object variants is sent as one object (merged properties, common `required`, variants summarized in `description`); a tool whose schema still is not a top-level object fails the request locally with a `bad_request` naming the tool. `toolSchemaProblem` is exported for callers' own checks.
