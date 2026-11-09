# Working on Psyche with agents

Psyche is a local-first macOS personal agent:
- `apps/desktop`: the Electron app
- `apps/gateway`: the Node Gateway, "psyched"
- `apps/mac-helper`: the Swift helper
- `apps/ios`: the SwiftUI iOS app
- `apps/web`: the web shell
- `packages/*`: shared code

The repo's top-level `skills/` folder holds Psyche's own product skills, not Claude Code skills. Claude Code skills live in `.claude/skills/`.

One Opus session orchestrates: it dispatches builder sessions, verifies their work and merges. Builders run on Haiku 5.5 unless the orchestrator picks otherwise. Builders: start by invoking the `psyche-builder` skill. The orchestrator uses `orchestrate`, and `reflect` improves the skills over time.

## Hard rules (every session)

**The owner's install**
- Never touch `/Applications/Psyche.app`, the `com.psyche.gateway` LaunchAgent, or anything under `~/.psyche`. You may read `~/.psyche/logs/*` with cat, grep or tail when diagnosing.
- Never execute a built `Psyche.app` or its MacOS binary. It rewires the owner's LaunchAgent and migrates their data. Run `psyched` only with a temporary `PSYCHE_HOME`.
- No osascript against the owner's real apps. Don't kill the owner's running Psyche or helper processes.

**Machine load**
- No VMs, containers or local models (Ollama, llama.cpp, MLX…) without the owner's go-ahead. The orchestrator warns the owner first.
- Tests: vitest with `--maxWorkers=1`, on the files you touched. Never run `pnpm -w typecheck`, `pnpm -r test`, Electron e2e or real-browser suites locally.
- One Swift or Xcode build at a time on this Mac: check `pgrep -fl 'swift-build|xcodebuild'` before building. The owner's Xcode build dir may point at an unmounted `/Volumes/External`. Use `-derivedDataPath` inside your worktree, or the project's `WorkspaceSettings.xcsettings` override.
- Tests must never pop keychain, Touch ID or permission dialogs.

**Git and PRs**
- Branch from `origin/main` and merge `origin/main` in when needed. Never `git reset --soft` onto main, never use a bare `git stash`, never force-push someone else's branch.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Don't merge your own PR. The orchestrator merges after verification.

**Product**
- Every user-visible string goes through i18n in all 10 languages: `pnpm i18n:check`, and the iOS `Localizable.xcstrings`.
- Free signing path: no Developer ID, notarization, APNs, TestFlight or provisioning-profile entitlements. Don't build anything that needs them.
- Approvals are a plain button tap. Touch ID or a password is only for payments. Don't add presence steps, delays or rate limits that can trip the owner's own paired device.

## Verification

GitHub Actions is locked by billing, so local checks are the gate. `.claude/scripts/verify.sh` checks what your branch touched:
- biome, secret-grep, protocol and i18n checks;
- typecheck for the touched packages;
- the touched tests.

It also runs existing tests that import the source you touched; skip them only with `--no-related`. Add `--swift` for Swift.

In a worktree, a Stop hook runs it whenever you finish with unverified changes. If it fails, you get the failures back and must fix them. It gives up after 3 tries, and then you must report the failure plainly. Never weaken or skip a test to get it passing.
