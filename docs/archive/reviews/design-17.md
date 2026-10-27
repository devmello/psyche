# design-17: host-side child processes inherit the Gateway's environment, and other same-user processes can read it

**Severity:** High. **Surface:** spawning srt-wrapped helpers, stdio MCP servers, `exec_host`, LibreOffice/ffmpeg converters, the desktop ↔ Gateway handshake. **Docs:** 05 §4.6 ("never of the image or `config.json`"), §5.3, §10 (Docker `PSYCHE_GATEWAY_TOKEN_FILE`), §11 (MCP "secrets via env at spawn"); 02 §9. **Owners:** S01, S09, S21, S11.

## Attack

1. **Inheritance.** Node's `child_process.spawn` without an `env` option passes the whole `process.env`. In server and Docker mode, provider keys are commonly env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`); so are `PSYCHE_VAULT_KEY_FILE` (a path, but it leads to the DEK), `PSYCHE_GATEWAY_TOKEN_FILE`, and any `*_TOKEN` the operator exported. Every converter, `exec_host` command and plugin-spawned helper that forgets `env` gets them. srt limits the *network* to an allowlist, but a stdio MCP server with an allowlisted host (its own API) can send the env there, and a malicious `.mcpb` server can read its own environment.
2. **The MCP SDK merges; it does not isolate.** With no `env`, `StdioClientTransport` passes only `HOME, LOGNAME, PATH, SHELL, TERM, USER`. When `env` is passed it is merged on top of those defaults. That part is safe, but an implementer who writes `env: { ...process.env, ...secrets }` (the common idiom for "keep PATH working") hands the server everything.
3. **Same-user processes can read env.** On macOS, `ps -E` / `KERN_PROCARGS2` shows the environment of any same-user process, **including hardened-runtime signed binaries**. Only Apple platform binaries are shielded (verified on macOS 27, SIP on). So "secrets become environment variables of one process" (§4.6, Bitwarden's model) means "readable by local malware running as the owner", which §1.3 says A1 is protected against. The same holds for a per-launch handshake secret passed to the Gateway or desktop through env (design-19).
4. **Env through the PTY.** The user's terminal pane in host mode inherits the desktop's environment. Anything Electron set (for example `ELECTRON_*` or a handshake secret) is in the shell.

## Assumption broken

"Env at spawn is scoped to that process." It is scoped to that process tree **and** readable by every process of the same user.

## Proposed control

- One spawn helper (`@psyche/proc.spawn`) that every package must use, enforced with a lint rule banning bare `child_process`. It **requires** an explicit env, built from an allowlist (`PATH`, `HOME`, `LANG`, `TMPDIR`) plus named additions. `process.env` spread is banned.
- At Gateway start, read provider keys and tokens from env into the vault or memory, then **delete them from `process.env`** (`delete process.env.ANTHROPIC_API_KEY`) so no later spawn can inherit them.
- On macOS, for secrets handed to children, prefer an fd (a pipe on fd 3 that the child reads once) or a 0600 file it unlinks after reading, over env. Keep env injection for tools that cannot do this, and label those items "readable by your other apps while running".
- `psyche security audit` flags provider keys found in the Gateway's own env at start.

## Test case

```ts
process.env.PSYCHE_CANARY_KEY = "canary-sk-123";
await gateway.start();
expect(process.env.PSYCHE_CANARY_KEY).toBeUndefined();                     // scrubbed at boot
for (const kind of ["mcp-stdio", "converter:libreoffice", "exec_host", "srt-helper", "terminal-pty"]) {
  const env = await spawnProbe(kind, ["/usr/bin/env"]);                    // prints child env
  expect(env).not.toMatch(/canary-sk-123|ANTHROPIC_API_KEY|PSYCHE_GATEWAY_TOKEN|PSYCHE_HANDSHAKE/);
}
expect(lint("packages/**/src/**/*.ts", "no-restricted-imports:child_process")).toHaveNoViolations();
```
