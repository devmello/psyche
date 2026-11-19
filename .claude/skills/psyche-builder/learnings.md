# Builder learnings

Curated by the `reflect` skill from PR "Learnings" sections, verify failures and review findings. Builders read this. Builders don't edit it directly: write learnings in your PR body instead. Each line says what happened, what to do, and where it came from.

- zsh does not word-split `$files`. Run multi-file commands and probe loops under `bash -c`, or use arrays. Otherwise vitest reports false failures. (2026-11-05, #1372)
- macOS has no `timeout` command. Don't wrap commands in it. (2026-11-05)
- macOS `/bin/bash` is 3.2: no `mapfile`, use a `while read` loop (#1371). `sed -i` needs a suffix argument, `sed -i ''` (#1369). `rg` in the Bash tool is a shell function around the Claude binary, not a file on PATH (#1372). (2026-11-19)
- Writing a heredoc'd script with absolute paths outside the worktree makes the shell tool refuse as "too complex": write it to the scratchpad and run it. The Write tool turns U+2028 in source into the literal character; use `\p{Zl}\p{Zp}` in regexes (#1366). (2026-11-19)
- After renaming a prop, check the destructured names: a `ReferenceError` there surfaces in the UI as a generic error (#1369). In tests, `describeCall` reads the sandbox's last known state: call it once and wait a tick before expecting `meta.hostProgram` (#1368). (2026-11-19)
- `@psyche/audit`'s `sha256` returns a `sha256:`-prefixed digest. Strip the prefix when another side expects bare hex: the helper's and WebAuthn's challenges. (2026-11-09)
- Edit a test file after running biome and it can still fail lint on formatting. Run `biome check --write` as the very last step. (2026-10-26)
- Adding a protocol enum value breaks the Swift helper's exhaustive switches, and Linux CI never builds Swift. Grep `apps/mac-helper/Sources` for the enum. (2026-10-26)
- `pgrep -f "<pattern>"` inside a command line that contains the same pattern matches itself and waits forever. (2026-10-19)
- Some axe and story checks fail only on macOS (`landmark-unique`), so Linux CI can't see them. (2026-11-02)
- Never spread client `params` into a call that also carries server-decided trust flags (`local`, `decidedBy`, scope). A client can send the same key, and protocol schemas allow extra properties. Set trust fields only from the connection, after the spread or as a separate argument. (2026-11-09, #1299: `local: true` spoofing bypassed the approval lockout)
- Don't keep a "fails on main" list here: it goes stale (#1307 and #1310 fixed the three that were listed). verify.sh reports base failures itself. To check one by hand, run the file in a clean checkout of `origin/main`. (2026-11-10)
- `startTestGateway()` defaults `hostPlatform` to the machine's OS. A test that simulates a `linux-helper` must pass `hostPlatform: "linux"`, or it fails on macOS. Compare `tmpdir()` paths after `realpathSync` (`/var` vs `/private/var`). (2026-11-10, #1307)
- Wording in the broker's error messages is user-visible: iOS shows the Gateway's English message for a failed approval answer. (2026-11-10, #1309)
