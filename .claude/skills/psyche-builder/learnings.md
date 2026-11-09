# Builder learnings

Curated by the `reflect` skill from PR "Learnings" sections, verify failures and review findings. Builders read this. Builders don't edit it directly: write learnings in your PR body instead. Each line says what happened, what to do, and where it came from.

- zsh does not word-split `$files`. Run multi-file commands under `bash -c`, or use arrays. Otherwise vitest reports false failures. (2026-11-05)
- macOS has no `timeout` command. Don't wrap commands in it. (2026-11-05)
- `@psyche/audit`'s `sha256` returns a `sha256:`-prefixed digest. Strip the prefix when another side expects bare hex: the helper's and WebAuthn's challenges. (2026-11-09)
- Edit a test file after running biome and it can still fail lint on formatting. Run `biome check --write` as the very last step. (2026-10-26)
- Adding a protocol enum value breaks the Swift helper's exhaustive switches, and Linux CI never builds Swift. Grep `apps/mac-helper/Sources` for the enum. (2026-10-26)
- `pgrep -f "<pattern>"` inside a command line that contains the same pattern matches itself and waits forever. (2026-10-19)
- Some axe and story checks fail only on macOS (`landmark-unique`), so Linux CI can't see them. (2026-11-02)
- Never spread client `params` into a call that also carries server-decided trust flags (`local`, `decidedBy`, scope). A client can send the same key, and protocol schemas allow extra properties. Set trust fields only from the connection, after the spread or as a separate argument. (2026-11-09, #1299: `local: true` spoofing bypassed the approval lockout)
