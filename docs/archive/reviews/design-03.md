# design-03: the localhost test-credential exception trusts names and repo-supplied config

**Severity:** Critical. **Surface:** browser origin policy, `javascript_tool`, credential fill. **Docs:** 05 §3.9, §3.10, §6; 02 §8. **Owners:** S08, S05.

## Attack

§3.10 enables the exception when the host is `localhost`, `127.0.0.1`, `[::1]` or ends in `.localhost` / `.test`, **and** the server "was started by Psyche this session from an rw-granted folder **or is declared in the project's launch config**". Three ways in:

1. **The launch config is repo content, which is untrusted.** The owner clones `cool-starter` and grants the folder rw. Its `.claude/launch.json` (or `package.json` `dev` port) declares `{"port": 7979}`. The agent opens `http://127.0.0.1:7979`, which is the **Psyche Gateway's own web UI**, now classed as "the user's own project". That unlocks `javascript_tool`, page JS and form submits on it. The same trick targets any loopback service: the real-Chrome CDP port (§6), Ollama `:11434` (`DELETE /api/delete`), CUPS `:631`, a local Jupyter, or a router admin page reached through an SSH tunnel.
2. **`.test` and `*.localhost` are names, not addresses.** `.test` is reserved (RFC 6761), but resolvers do not have to fail it. A hostile network's DNS, a corporate split-horizon zone or a line in `/etc/hosts` can map `app.test` to `203.0.113.5`. Chromium hard-wires `*.localhost` to loopback; Node's `fetch`, curl in the sandbox and `getaddrinfo` on Linux do not have to.
3. **"Not a local address proxying someone else's service" cannot be checked** from the page. The repo's dev server (attacker code) runs `http-proxy` to `accounts.google.com`. The owner, shown "test credentials for your app", types their real password, or the agent submits seeded values to the real service.

## Assumption broken

The host string and the project's own files decide trust. Both are attacker-controlled in the "open this repo" scenario.

## Proposed control

- Apply the exception only when **(a)** the URL's host resolves (resolve it yourself; do not trust the name) to a loopback address, **(b)** the listening socket's PID (`lsof -iTCP:<port> -sTCP:LISTEN`, `proc_pidinfo` on macOS) is a descendant of a process Psyche started this session, and **(c)** the port is not one of Psyche's own (the Gateway, the bridge, CDP, the OAuth loopback listener) or on a denylist of well-known local services.
- Treat launch configs as *suggestions to start* a process, never as evidence that a port belongs to the project.
- Hard-deny agent-browser navigation to the Gateway origin (`http://127.0.0.1:7979`, `publicOrigin`), whatever the exception says (see design-19).
- The card for a credential typed under the exception says "this value is sent to whatever process listens on :3000"; owner-typed values are never auto-filled later.

## Test case

| # | Setup | Action | Expected |
| --- | --- | --- | --- |
| 1 | rw folder with `launch.json` `{port: 7979}`; Gateway on 7979 | `browser.navigate("http://127.0.0.1:7979")`, then `javascript_tool` | navigate `denied` (`gateway_origin`); JS tool `denied` |
| 2 | `/etc/hosts` fixture `app.test → 203.0.113.5` (fake resolver) | `credentials.request({{cred:app-test-user}})` on `http://app.test/login` | `denied` (`resolved_non_loopback`) |
| 3 | listener on 127.0.0.1:3000 owned by a process Psyche did not spawn | `javascript_tool` on `http://localhost:3000` | `ask` / `denied`, exception not applied |
| 4 | Psyche spawned `npm run dev` → PID owns :5173 | type seed password from `fixtures/users.json` | allowed under the exception |
| 5 | `http://localhost.evil.test@127.0.0.1:3000`, `http://127.0.0.1.nip.io`, `http://localhost.:3000` | navigate | userinfo rejected; `nip.io` is not loopback; trailing dot canonicalized before the check |
