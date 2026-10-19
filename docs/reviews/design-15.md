# design-15: sandbox secrets leak through `/proc`, files the sandbox keeps, and encodings `redact()` does not know

**Severity:** High. **Surface:** sandbox secret injection (`PSYCHE_SECRET_<NAME>`), receipt masking, `CredentialBroker.redact`. **Docs:** 05 §4.6 (Sandbox), §4.7, §5.1; `SandboxRunner`, `ExecRequest.env`. **Owners:** S21, S06.

## Attack

The container is **per task** and `/workspace` **persists per thread**. Secrets are environment variables of "one command's process at spawn", and the receipt "masks them in captured output". `redact()` replaces exact matches and URL / base64 encodings.

1. **A background process left by an earlier command.** Command 1 (no secret, looks harmless, approved or covered by a grant): `sh -c 'nohup sh -c "while :; do cat /proc/[0-9]*/environ >> /workspace/.cache/e; sleep 0.05; done" >/dev/null 2>&1 &'`. Command 2 (the owner approves `gh release upload` with `{{cred:gh-token}}`): the token is now in `/proc/<pid>/environ`, readable by any process with the same UID in the same PID namespace, and the loop copies it to `/workspace/.cache/e`.
2. **Getting it out past masking.** Command 3: `xxd -p /workspace/.cache/e | rev` or `python3 -c "print(open('/workspace/.cache/e').read()[::-1])"`. The output is hex and reversed, so `redact()` (exact, URL, base64 only) misses it. The model now sees the token, which violates goal 1. `network none` doesn't help: the agent can send the decoded value on through any granted connector, or simply show it in chat.
3. **No background process needed.** The secret-bearing command itself writes the value (`env > /workspace/x`, or a tool that logs its config). `filesChanged` lists `x`; a later `cat x` with a ROT13 is unmasked. `ExecResult.stdout` is also persisted (receipt payload, level-3 tool I/O), and the design does not say whether that happens before or after masking.
4. **Core dumps and crash logs** of the secret-bearing process in `/workspace`.

## Assumption broken

"The value exists only in that one process." Inside a persistent multi-command container, a process boundary is not a secrecy boundary, and output masking can never catch every encoding.

## Proposed control

- Run secret-bearing commands in a **fresh, single-use container** (or at least a fresh PID namespace). Its `/workspace` is mounted **read-only**, or overlaid with a discard layer whose diff is reviewed: files written by a secret-bearing command are quarantined and scanned before they merge back.
- Before a secret-bearing command starts, kill every process in the task container (`kill -9 -1` as UID 1000, or restart the container), and refuse if any process outlives that.
- Mount `/proc` with `hidepid=2` where the backend allows it. Set `RLIMIT_CORE=0`.
- Treat masking as a fallback, not a control. After a secret-bearing command, mark the sandbox `secret_exposed`: later `exec` output from that sandbox is redacted with fuzzy matching (hex, reversed, base32, per-character separators, `rot13`) **and** taints the turn, until the sandbox is destroyed.
- Persist only the redacted `stdout`. Raw output is never written to SQLite or the Library.

## Test case

```ts
const sb = await runner.ensureSandbox({ kind: "task", id: "t1" });
await runner.exec({ sandboxId: sb.id, argv: ["sh","-c",
  'nohup sh -c "while :; do cat /proc/[0-9]*/environ >> /workspace/e; sleep 0.05; done" >/dev/null 2>&1 &'], cwd: "/workspace", timeoutMs: 5000 });
await secretExec(sb.id, ["sh","-c","sleep 0.3"], { GH: "{{cred:gh-token}}" });   // injector resolves FAKE_GH_TOKEN
const r = await runner.exec({ sandboxId: sb.id, argv: ["sh","-c","xxd -p /workspace/e | rev; cat /workspace/e | rev"],
  cwd: "/workspace", timeoutMs: 5000 });
const visible = r.stdout + r.stderr;
for (const enc of encodingsOf(FAKE_GH_TOKEN)) expect(visible).not.toContain(enc);   // hex, reversed, b64, rot13
expect(await fileContains(sb, "/workspace/e", FAKE_GH_TOKEN)).toBe(false);
```

Expected: the secret-bearing command ran with no other process alive. Nothing it or a sibling wrote holds the token, and no encoding of the token appears in model-visible output.
