---
"@psyche/protocol": minor
"@psyche/gateway": minor
"@psyche/desktop": minor
"@psyche/ui": minor
"@psyche/web": minor
---

Settings → About → Uninstall Psyche: a sheet that stops the Gateway agent and the helper, lists what goes to the Trash, and keeps your data by default. Deleting data needs a typed word and fresh presence (new method `app.uninstall.authorize`) and only works from the desktop app on the Mac running the Gateway. `deploy/macos/install-local.sh` now keeps your data by default (wiping is an explicit `--reset`), and the Homebrew cask gains `auto_updates` and a full `zap`.
