---
name: psyche-permissions
description: Changing Psyche's permissions, approvals and trust code. Covers the broker and its answer limits, approval cards and presence (Touch ID or password, for payments only), sealed security settings, the Auto-mode model allowlist, and every rule that classifies inputs into a risk class, above all the payment rule in money-intent (computer use, browser, MCP). Use for any change in packages/permissions, apps/gateway/src/security, presence or approvals handlers, compose/helper.ts, compose/computer.ts money checks, the model-router allowlist or packages/protocol/src/money-intent.ts.
---

# Permissions, approvals and classifiers

Every PR here gets an independent security review. #1299, #1300, #1301, #1354 and #1368 needed 2 to 5 fix rounds each. The traps below caused most of those rounds. Read them before the first edit.

## Where things live

- **Broker:** `packages/permissions/src/broker.ts`. It handles answers, the failure cap and `requiresAuthentication` (financial, purchase or an explicit flag). Its handlers are in `packages/permissions/src/handlers.ts`, and the deterministic classifier is `RulesClassifier` in `classifier.ts`. No model classifier is wired in.
- **Presence gate:** `apps/gateway/src/presence-gate.ts` and the context fields `presenceState` and `presenceCanVerify` (`apps/gateway/src/context.ts`). Mac sheets and helper signing are in `compose/helper.ts`.
- **Seal:** `apps/gateway/src/security/seal-spec.ts` (`isSecuritySettingKey`) and `state-seal.ts` (`isAuthorizingSetting`, `reseal()`). Presence for settings is `needsPresence` with `OWNER_CHOICE_KEYS` in `apps/gateway/src/handlers/settings.ts`.
- **Payment rule:** `packages/protocol/src/money-intent.ts` (`@psyche/protocol/money-intent`), used by `compose/computer.ts`, `packages/browser/src/tools/classify.ts` and `packages/mcp-host/src/policy.ts`. The owner's override is `mcp.handlesMoney.set` (`compose/mcp-manage.ts`).
- **Auto allowlist:** `AUTO_MODE_KIND_RULES` in `packages/model-router/src/router.ts`.
- **Spec:** `docs/05-security-and-permissions.md`, with §3.7 for approvals and presence and §3.12 for floors.

## Owner decisions (don't "fix" these)

- Approvals are a plain tap from a paired device. Touch ID or the password is only for payments: `financial` or `purchase`. The financial floor is never liftable, and a payment is `once` only, never Always. (2026-11-09)
- Mac-control approvals stay a tap from any device. A stolen admin device is an accepted residual risk, documented in §3.7. (2026-11-09)
- Auto is allowed on the smallest model tiers too. (2026-11-09)
- The one exception to payments-only: adding a verifier (a first passkey, a Windows Hello key, applying a presence reset at once) needs the presence step whenever a helper can verify (`presenceCanVerify`), so a stolen admin device can't enrol its own authenticator (§3.7).

## 1. Trust comes from the connection only

`local`, `decidedBy`, scope and surface are set by the server from the connection (`Caller`). Never spread client `params` into a call that carries them. Protocol schemas accept extra keys, so a client can send `local: true`. Pass trust as a separate argument, the way `broker.answer(input, { local: c.local === true })` does. (#1299 R2: a remote device spoofed `local: true` and dodged the lockout.)

## 2. Changing a shared predicate

A fix that changes who counts as local, enrolled, ready, owner-choice or financial changes every caller of that predicate. Twice on 2026-11-09 the fix for one finding opened the next hole:
- #1299 R2: the per-call `local` flag led to the params spoofing.
- #1301 R2: the enrollment fix for finding 5 opened B1, a first passkey with no sheet.

Before you push such a fix:
1. `git grep` the predicate and list every caller in your report. Say for each whether it should widen, narrow or stay the same.
2. Add a test for at least one caller you did *not* mean to change, asserting that it still behaves as before.
3. When you drop a presence step from a security setting, keep it sealed. `permissions.mode` stayed in `isSecuritySettingKey` through `OWNER_CHOICE_KEYS` (#1300 R1, finding 2).

## 3. Classifiers: precise both ways

This covers any rule that sorts inputs into "asks" and "doesn't ask": money-intent, the failure cap's guessing-shaped rejections, the Auto allowlist. A miss lets a payment through on a tap, and a false match puts a sheet in front of an ordinary action. The rule in money-intent:
- **Verb plus object or amount:** a money verb needs a money object ("send money") or an amount ("Send $50", "Send 0.1 ETH"). A bare payment label also counts ("Pay", "Place bid"). A word alone doesn't: "transfer", "checkout", "card" and "token" name git, files and logins as often as payments.
- **Navigation never pays:** a link or a GET form doesn't pay. Only the control that submits does. Quote, estimate and preview tools move nothing.
- **Every activation path:** a click by point, Return, Enter, Space, a typed newline or space, and Tab followed by any of those. Check what is under the point or the focus (`computer.resolve_target`) before each piece that could activate (`moneyUnderFocus`, `moneyAfterFocusMove`). #1301 needed rounds 3, 4 and 5 to cover keyboard, Tab and space one at a time.
- **Fail closed:** if the target can't be read (an old helper, a Windows or Linux helper), refuse with `point_unchecked` or `focus_unchecked`. Don't let it through.
- **Unlabelled targets:** treat them as unknown and use context: the window title or URL, the parent labels, a recent payment in the same app.
- **An owner flag beats the heuristic:** a tool renamed to dodge the words still pays under `handlesMoney`. A raw `settings.set` must not be able to clear that flag.
- **No whole-label or whole-route exemptions.** An early exit for a label, route or word class ("transfers", listing words, leave dialogs, article segments) un-blocks real flows. #1321 needed 7 rounds, most of them for this. Narrow the match instead, and add a row for the flow the exemption would have let through.
- **Match on kind:** match on the provider's kind, never on an id a user can choose. #1300 R2: the id `anthropic` on an `anthropic-compatible` endpoint passed, and the real CLI refs didn't.

**Write the probe table first.** Before you change a rule, write a table-driven test with two lists: inputs that must match, and near-misses that share a word and must not. The pattern is `packages/protocol/test/money-intent.test.ts`: `PAYMENT_LABELS` and `ORDINARY_LABELS` with `it.each`. Include amounts with decimals, tickers, keyboard paths, snake_case and camelCase tool names, and the reviewer's probes from every earlier round. Every review finding becomes a row that failed before your fix. In #1301, round 1 widened regexes one way only. Rounds 2 to 5 each found misses in the other direction, and the reviewers' two-way probe lists caught them.

- **Check the host being read, not only the stored entry.** #1340 took 3 rounds: trust checks ran on the trusted host only, not on the host actually read.
- **A new quiet allow must never feed another allow path.** #1340: a "trusted" quiet read marked the origin `touched`, so later tainted reads were allowed.
- **Grant labels come from the full scope.** An "always" grant's label is derived from to+cc+bcc, not the first recipient (#1346). Redacted values never come back as input (#1343).

## 3b. Hardening fails closed, on the right target

- **Unexpressible input means ask or refuse, never `continue`.** #1329: a git driver name that couldn't be expressed was skipped, `(.+)` missed empty names, and `status.ignoreSubmodules` was a config key git doesn't have. Check a config key or flag against the tool itself (`git config --help`, run it), not memory.
- **Validate what the tool will resolve, not what encloses it.** #1329 B2 checked the enclosing repo, not the repo git actually resolves (`-C`, `GIT_DIR`, alternates, submodules). Resolve first, then check that result.
- **Every new action path gets checked against every existing prohibition.** #1315's purchase tool skipped #1321's hard block. When a PR adds a tool, route or channel that can act, list the prohibitions (money block, outbound check, read-only allowlist, presence) and add a test per prohibition through the new path.
- **Mutations bind to the fd you checked.** If the checked handle can't be opened, refuse; a by-path `chmod`/`rename` fallback follows a swapped link out of the share (#1450 r1). Copied mode bits drop setuid, setgid and sticky.
- **Identity comes from the server or kernel, not a client-set field.** Window ownership uses X-Resource `LocalClientPID` plus the cgroup scope, never `_NET_WM_PID`; a missing answer refuses (#1293 r6, #1452 r1).
- **Hidden line breaks in approval text.** U+0085 (NEL) and C1 controls break lines in iOS text layout, so an approval display sanitizer must neutralise them on both TS and Swift (#1537).
- **"Removing" can widen access.** A list where empty falls back to a broader list (`groupAllowFrom` → `allowFrom`) is not tightening-only: test the empty case (#1529).
- **Presence stays payments-only.** #1327's agent search popped a vault unlock. Reads and searches never trigger Touch ID or a vault prompt.

## 3c. Redacted reads, "is this narrower?" checks, receipts

- **Redacted reads must not round-trip into writes.** When a getter redacts (env values, URL tokens, OAuth fields, bearer credentials), the raw setter for the same key must refuse, or merge-preserve every stored secret for existing ids. #1351 B1: `settings.get mcp.servers` then `settings.set` with the same value wiped secrets on every entry, and a one-field toggle did the same. Test it: get, set the same value, stored value unchanged. Check the CLI (`psyche config`) and `useSettings().set` too.
- **A pure "is this narrower?" check must model how the engine resolves.** #1354 took three rounds (the orchestrator fixed r2). Probe through the real `decide()`, not only the pure function. Cover:
  - longest-root folder matching, including session folder grants the check can't see, so removing a `ro` child under an `rw` parent widens;
  - first-match order for `sites` and `apps`, and make sure the order check runs when order is the only change (an early `same()` skip hid it);
  - `canonicalPath`, not raw strings;
  - `compilePolicy` vs `parsePolicy`;
  - settings nothing reads.
  When in doubt, show the card.
- **Match receipts to approvals by grant or approval id, never by kind and task.** Connector receipts carry `tool.action` kinds (`gmail.send`) and no `taskId`, so a kind+task match reports a successful action as failed (#1358 B1).

## 3d. Exec, argv and path confinement (#1361, #1364, #1368, #1372)

- **Name lists** (programs, files, keys) fold before matching, and resolve paths with `realpathSync.native`. `toLowerCase()` alone misses `ſ`, `ﬁ` and `ẞ`; use `normalize("NFKC").toLowerCase().toUpperCase().toLowerCase().normalize("NFKC")`, plus a `dev:ino` check for paths that already exist. Tests include those spellings.
- **Path confinement covers every way a tool reads a path:** symlink-following flags (`-L`, `--follow`, `-R`, `-S`, `-follow`, `-H`) and path-valued options (`--file=`, `--ignore-file=`, `-f`, `--files0-from=`, `jq -L<dir>`), not just operands. Back it with an srt `denyRead` on the shared temp roots (`/private/tmp`, `/private/var/folders`, `/Users/Shared`), not only home.
- **Argv classifiers (which arguments are option values):**
  - `--` can itself be an option's value, so dash-led arguments after it are not trusted to be operands (#1368 r1, HIGH).
  - Value letters with an attached value differ per tool: `tree -L2` takes nothing from the next argument, while `tree -L 2` does (#1372 r1). Never assume getopt.
  - macOS tools accept GNU-style long-option abbreviations (`file --f=` is `--files-from`); prefixes of 3 or more characters count. With exact names only in a table, the abbreviation's value is path-checked as an operand, which fails closed. Keep it that way.
  - Probe every value letter against the real binary on this Mac by passing an outside path as the "value", and record in the PR which table rows came from man pages only (#1372 r1 did this for rg 14, BSD grep, du, head, tail, jq, tree).
  - Skipping a value (treating it as a plain slot) is a relaxation and needs its own security review. Unlisted options fail closed: the value counts as an operand and is path-checked.
- **Folder and root refusal (#1384, #1387, #1388, #1395):**
  - A grant-time refusal alone leaves old grants live. Check at use time in every consumer (`folderFor`, `grantedFolders()`, exec-host), never from raw `policy.folders`. A memoised answer must not be the only gate where the consumer resolves paths itself: re-check the real path there. Don't memoise errors (a hung mount blocks, but a transient ELOOP must not stick).
  - macOS magic prefixes (`/.nofollow/`, `/.resolve/`, `/.vol/<dev>/<ino>`) get past a lexical root check, `/opt` included (#1384 r1, HIGH). Judge `realpathSync.native`, and fold case with the volume's rules (APFS), not `toLowerCase` alone.
  - Home-sensitive refusal is judged against the user whose files run, not `os.homedir()`: pass `home` in the env (#1388).
  - "Moved" must compare against the realpath of the stored root and of its parents: a swapped parent is not a move (#1395 r1, HIGH; #1389 regressed here).
- **Lookups fail closed**, and map every subscriber before moving an emit (`psyche-builder` §2).
- Keep each probe as a table row.

## 3e. Grants with identity, attachments, vault slugs (#1366, #1373)

- **A single-file grant matches by equality**, never as a path prefix: a prefix grant becomes a folder grant when the file is replaced by a directory (#1366 r1). At read time re-check it is a regular file with `nlink === 1` (hard links), and again at send.
- **Expiry applies in every accessor** (the engine, the Settings list, the raw map), not one getter (#1366 r1).
- **Clear chat and delete call `endSession` through the real handlers**, and tests go through those handlers, not the broker directly (#1366 r1). Catch and log failures (`thread-end.ts`).
- **A "record" separate from a grant never grants a read.** Filter it by a live grant (a file entry or a covering folder) before promising a read, and a re-attach refreshes both expiries (#1366 r3, #1374).
- **Third-party text into prompts:** filenames, paths and the like go in a fenced block with JSON-quoted values, tainted, never bare text framed as the owner's words (#1366 r1).
- **Writing a vault item by slug:** first check the existing item is ours (kind, `ownerConnectorId`, exact bindings), as `mcp-manage.ts` does, otherwise use a fresh slug (#1373 r1). Changing a client must not silently reuse the old secret. Audit actors for admin calls are `{type: "device", deviceId}`, with no `name`.

## 3f. Owner text on its way to a model (#1407 r1)

Redact first, then trim, then slice, on every path (immediate and batched). Truncating raw text first lets a vault value that straddles the cut slip past the redactor. Match a provider on `config.kind`, never `?? id`. A cheap default model needs a fallback, or compaction fails for good; a gate must not fail open or silently turn off for local primaries. Test with the real redactor.

## 3g. Checklist: findings that keep coming back (#1533, #1540, #1544, #1545, #1546, #1549)

Before the PR, answer each in the body:
- **Symlink write-through.** A file that `git pull`/checkout can replace (a repo file the Gateway also writes) may be swapped for a symlink: refuse writes through links and write via temp file plus rename, re-checking the target at use (#1533).
- **Case and Unicode folding.** APFS folds case and Unicode, so protected-name checks (`.git`, `.env`, program names) must fold like `psyche-permissions` §3d, with `ſ` and ligature rows in the table test (#1544, #1540).
- **Narrowing reaches live state.** A setting that narrows (sites, apps, folders, tools) must also apply to what is already open: browser tabs, running sessions, cached policies. Test with state opened before the change (#1545).
- **srt/sandbox write boundary.** List what runs later or redirects git: `.git/commondir`, nested `.git` files (`gitdir:` pointers), `.git/config` and hooks, launch-config files (see the reviewer's launch-config list). `denyWrite` the files, not just the directory name (#1546).
- **Approval-triggered actions run server-side and report failure.** An install that an approval triggers must run on the Gateway, not in a UI that may be unmounted, and surface failure to the owner (security reviews of the install PRs, #1581, wave 2026-11-24).
- **Exceptions in detectors.** An ID-shape or "looks like a token" exemption must apply only on the path it was meant for (owner-facing redaction), never on blocking paths (#1549).

## 4. Trust that moves to a new path or file

If a client now trusts a different path (a socket, a pointer file, a config), the old `$PSYCHE_HOME` ownership no longer vouches for it. #1308 moved the helper's socket outside `$PSYCHE_HOME`, and the review found an impostor-Gateway risk: screen, computer use and `presence.confirm` signatures.
- **Check the peer:** the process on the other end must be this user (`getpeereid` on the helper).
- **Check the directory:** the target's parent must be a real directory (not a symlink) owned by this user, with `mode & 0o077 == 0`.
- **One descriptor:** open with `O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC`, then `fstat` and read from that fd. `lstat` then open leaves a race.
- **A new guard can mask old negative tests.** After you add one, build each reject case so only its own check can reject (a private directory for the NUL test, say), and add an accepted case at each boundary. Two old tests in #1308 stopped testing their own checks.

## 5. Tests to run

`verify.sh --related` runs the related tests (run it once before the PR for changes here: permission code is widely imported). These suites break most often when this area changes:
- **permissions:** `answer-lockout`;
- **gateway:** `passkeys`, `remote-presence`, `payments-only-presence`, `seal-owner-choice` and the other `seal-*` suites, `mode-switch`, `computer`, `compose-mcp`, `device-rate-limits`;
- **protocol:** `money-intent`.

If you change copy that names Touch ID, presence or approvals, also run `packages/ui/test/platform-*.test.tsx` (#1301 R3; #1338). UI tests for approvals and grants use the shapes in `psyche-builder` §2.

## Learnings

- 2026-11-24: authority is checked at each use, not once at registration. #1616 checked the phone only in `NodeRegistry.phone()` at registration, where `machine()` re-checks on every use; a revoked or narrowed device kept working. A new device role re-reads revoke state and scopes on every call (#1616). A new path to an existing capability matches all its gates (#1614; see `psyche-builder` §2).

- 2026-11-10: a "cross-window lockout" follow-up was unreachable, because `isDesktopShell` requires loopback. Uncapped chat answers (#1306) are by design: only guessing is limited. Check a security follow-up against main before building it.
- 2026-11-19: a long helper action must keep its session alive by counting in-flight work: an idle timer that checks only the last acquire dropped the Esc tap mid-action (#1402 r1). A server woken from idle runs the same pre-start checks as a normal start (#1401 r1).
- 2026-11-19: narrowing which app paths may be launched or written broke Spotify (an updater copy), Safari (the cryptex symlink) and Shortcuts Events (CoreServices) in successive #1427 rounds. Before you ship, probe every installed bundle id with read-only LaunchServices queries (no launch, no `lsregister`) and test the cryptex and CoreServices locations. Keep LaunchServices/codesign answers behind injected lookups (`AppLaunchPolicy.Lookups`) so tests register nothing. `describeCall` is synchronous: a resolved path must come from an earlier call's cache plus a run-time card.
- 2026-11-19: an exception added for usability needs probes that the old attack still fails. #1438's ".claude link is known, never quarantined" re-opened a case #1435 quarantined; #1427 rounds 1-3 did the same. For each new exemption, re-run the earlier PR's probe rows.
- 2026-11-19: carry-forward logic (#1437 `carryPinned`) needs a revoke path and per-item trust; untrusted items must never evict trusted ones.
