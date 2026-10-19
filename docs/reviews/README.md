# Adversarial reviews (S23)

S23 is the red team. It writes no product code. Each finding states the attack, the design assumption it breaks, a severity, a proposed control and a concrete test case that S18 can add to the corpus. Phase 1 reviews the design (`docs/05`, `docs/02` §4.6–§4.7 and §8–§10, `docs/04` §4–§6, and the research notes KQ4, KQ5 and KQ2 §2k–2l). Phase 2 reviews each security-critical PR in `pr-<number>.md`, with failing tests under `tests/corpus/review-cases/<pr>/`.

Severity: **Critical**: secret disclosure, money, or host / control-plane compromise reachable from content alone. **High**: a broken stated invariant that needs one extra condition (a grant, a restart, a shared folder). **Medium**: needs an unusual configuration, or widens damage after another failure.

## Phase 1: design findings (2026-10-19)

| # | Sev | Finding | Main owners |
| --- | --- | --- | --- |
| [01](design-01.md) | Critical | A `site` credential grant lets a password be typed into any field on the bound origin (for example a public comment box) | S06, S08 |
| [02](design-02.md) | Critical | The `memory` tool can persist injected instructions outside the four protected files (`skills/`, `AGENTS.md`, case variants on APFS, symlinks, rename) | S07, S16 |
| [03](design-03.md) | Critical | The localhost test-credential exception trusts host names and repo launch configs (reaches the Gateway UI, `.test` DNS, proxying dev servers) | S08, S05 |
| [04](design-04.md) | Critical | Device-only approvals accept a click with no presence proof bound to `bindingHash` (web-UI XSS, lock-screen notifications); the docs disagree on whether chat may approve `destructive` | S05, S11, S14 |
| [05](design-05.md) | Critical | VM mode: the host desktop trusts the guest Gateway; the host vault releases plaintext based on an origin the guest claims | S14, S19, S06 |
| [06](design-06.md) | High | Memory provenance is parsed from Markdown the model writes; `writeFile` takes the caller's word for provenance | S07 |
| [07](design-07.md) | High | Taint is lost when untrusted content is written to a file and read in a later turn | S05, S02, S21 |
| [08](design-08.md) | High | Taint does not flow down into fresh subagents, Tasks after their first turn, or automations created by `schedule`; the classifier sees goals written by the agent | S02, S04, S05 |
| [09](design-09.md) | High | `reissue()` after a restart re-evaluates parked calls without their persisted taint | S05 |
| [10](design-10.md) | High | The form-submit binding omits the `action` URL, method, `formaction` and hidden fields; 307/308 redirects replay the body to another origin | S08 |
| [11](design-11.md) | High | `email.send`: grant key by recipient domain; `Reply-To`/`From` alias outside the hash; text and HTML parts can diverge | S09, S05 |
| [12](design-12.md) | High | Approval cards can be spoofed with newlines, bidi controls, homographs and Markdown in attacker strings | S05, S10, S12 |
| [13](design-13.md) | High | `canonicalJSON` collisions (NaN, Map, Date, NFC folding of executed strings); the 04 and 05 binding tables disagree; origin `"null"` matches in the fake | S05, S00, S18 |
| [14](design-14.md) | High | Exec grants bind argv, not the files in cwd (`git` fsmonitor, Makefile); stdin is unbound; `write_file` follows a symlink swapped in after verification | S05, S21 |
| [15](design-15.md) | High | Sandbox secrets leak through `/proc/*/environ` to processes that persist in the container, and through encodings `redact()` does not catch | S21, S06 |
| [16](design-16.md) | High | Custom auth headers survive redirects (undici strips only `authorization`/`cookie`); HTTP error objects carry headers into tool results and logs | S09, S06, S01 |
| [17](design-17.md) | High | Host child processes inherit the Gateway's env; same-user processes can read env on macOS (`ps -E`) | S01, S09, S21 |
| [18](design-18.md) | High | After a fill, page JS echoes the value spaced, reversed, in the title, dialogs, canvas or URL fragment | S08, S06 |
| [19](design-19.md) | High | Control plane: the loopback auto-approval secret is a bearer token; setup codes pre-approve pairing; the agent browser can load the Gateway UI; `Origin: null` | S01, S11, S08 |
| [20](design-20.md) | High | Node-scoped devices can call operator methods (`chat.send` as owner); answer tokens can leak in event fan-out; nodes self-declare side-effect classes | S01, S05, S19 |
| [21](design-21.md) | High | Owner identity is a bare handle string: SMS and RCS share the iMessage handle, Telegram anonymous admins share one id, `From:` spoofing, Slack team ids | S10 |
| [22](design-22.md) | High | Forwarded or quoted text inherits owner provenance; designated groups grant authority to new members; text-matched mentions; edits steer running Tasks | S10, S02 |
| [23](design-23.md) | High | MCP: server-id collisions with rules; `instructions`, prompts, resources and MCP Apps are not hashed; unpinned `npx -y` launches | S09 |
| [24](design-24.md) | High | Installed third-party skills become trusted instructions, including prerequisites the agent runs; the hash does not cover bundled files | S16, S02 |
| [25](design-25.md) | High | rw VM shares let the guest plant host-executed config (git hooks, `.envrc`, `.vscode`); firmlink and case aliases pass the "never home" check | S14, S19, S21 |
| [26](design-26.md) | Medium | Restoring a backup brings back revoked devices and grants; channel session keys sit outside the vault; Time Machine and Spotlight exposure; export is not presence-gated | S22, S01, S10 |
| [27](design-27.md) | Medium | The `fetch` tool's SSRF policy can be reached through alternative IP forms, DNS rebinding and redirects to loopback or metadata | S02, S15 |
| [28](design-28.md) | Medium | Grant-scope semantics: two definitions of `session`, chat answers that widen scope, `task` grants for destructive actions, unattended approvals vs expiry | S05, S10, S04 |

Doc contradictions S05 and the doc owners should settle first (they cause divergent implementations): chat approval of `destructive` (04), the binding-hash field tables in 04 §4.2 and 05 §3.5 (13), the `email.send` grant key (11), `session` scope storage (28), and Task taint inheritance, "first turn" vs open question 05 §16.7 (08).

Technical claims were checked on 2026-10-19 on macOS 27, Node 24.18 and git 2.54: undici's redirect header stripping, `ps -E` against hardened-runtime processes, the `/System/Volumes/Data` firmlink and `realpath`, APFS case-insensitivity, `core.fsmonitor` with `safe.directory`, WHATWG IPv4 parsing, and the S00 `canonicalJSON` collisions. The iMessage SMS handle row behavior is taken from the imessage-exporter schema (separate `handle` rows with the same `id` and a different `service`); it was not checked against a live `chat.db`.

## Phase 2: PR reviews

None yet. Each security-critical PR (touching `packages/permissions`, `vault`, `browser`, `sandbox`, `channels`, `mcp-host` or `apps/gateway` auth) gets `pr-<number>.md` within a day of opening.

| PR | Package | Review | Failing tests | Status |
| --- | --- | --- | --- | --- |
