# Security disclosure process

How Psyche handles a vulnerability report from the moment it arrives to the public write-up. [SECURITY.md](../SECURITY.md) is the short policy for reporters. This is the process maintainers follow, and what reporters and owners can expect. It implements [docs/05-security-and-permissions.md](05-security-and-permissions.md) §15.3.

## 1. Intake

- **Channels:** GitHub private vulnerability reporting (the **Security** tab) and the security email address once it exists. Reports that arrive anywhere else (a public issue, a discussion, a pull request, a chat) are moved to a private advisory at once, and the public copy is hidden or deleted with a note to the reporter.
- **Acknowledgement:** within 72 hours, from a maintainer, in the advisory thread. It confirms we received the report and says who is handling it.
- **What we may ask for:** a version or commit, reproduction steps, and whether the issue needs a non-default setting (computer use on, a non-loopback bind, an `always` grant, VM mode).

## 2. Triage (within 7 days)

1. **Reproduce** on `main` and on the latest release.
2. **Score** with CVSS 4.0, then adjust for Psyche's assets (docs/05 §1.2). The severity sets the fix target:

| Severity | Typical examples | Fix target |
| --- | --- | --- |
| Critical | A secret (vault item, device token) reaches model-visible text or a remote party; a side effect runs without owner authority; remote takeover of the Gateway | 7 days |
| High | An approval card that hides or misstates what it authorizes; a grant that outlives its scope; a sandbox or helper tier escape that needs one owner approval | 30 days |
| Medium | A deterministic control is bypassed but another layer still asks; local-only information disclosure | 90 days |
| Low | Defense-in-depth gaps, misleading messages, hardening | normal work |

3. **Decide scope**, using SECURITY.md. Out-of-scope reports get a reasoned answer, and a public issue if they are still worth fixing as hardening.
4. **Name an owner** (the package owner from `docs/09-execution-plan.md`) and a fix branch in a **private fork** opened from the advisory. Fixes for in-scope reports are never developed in public branches before disclosure.

## 3. Fix

- The fix lands with a regression test that fails before it, for example:
  - a corpus case in `tests/corpus/injection`;
  - a review case in `tests/corpus/review-cases`;
  - a package test.

  Prompt-injection classes also get a corpus case, so the nightly run guards them.
- If the issue is a misconfiguration class (an exposed bind, an open DM policy, a risky grant), `psyche security audit` gains a check for it (docs/05 §15.3).
- The reporter is offered a look at the fix before release.
- The per-release security checklist (docs/05 §15.4) runs on the release that carries the fix.

## 4. Release and advisory

1. Merge the private fork, tag a patch release, and build signed artifacts the usual way (`release.yml`).
2. Publish the GitHub security advisory on the same day. It names:
   - the affected versions;
   - the fixed version;
   - the severity;
   - workarounds;
   - credit.
3. **CVE:** requested through GitHub's CNA for every exploitable issue.
4. **In the app**, security releases show an update banner. There is no phone-home and no remote kill switch, so the advisory, the release notes and the banner are how owners hear about it.
5. **Embargo:** the default is publication when the fix ships, or 90 days after the report, whichever comes first. We agree a different date with the reporter only to finish a fix that is actively in progress, and say so in the advisory.

## 5. Write-up

Anything that shipped in a release gets a public write-up in `docs/release-notes/` (or linked from it) within 30 days of the advisory:
- what happened;
- which versions and configurations were affected;
- how it was found;
- how it was fixed;
- what changed so the class does not repeat.

## 6. What owners should do after an advisory

The owner-side runbook. The commands are from `apps/cli`; run them on the Gateway host.

1. **Upgrade.** Install the fixed release (DMG, Docker image digest from the release notes, or `pnpm` build), then run `psyche migrate` before starting it, as in the [upgrade guide](guides/upgrade.md).
2. **Check configuration.** Run `psyche security audit` and fix what it flags.
3. **If a device or token may be exposed:**
   - run `psyche devices list`;
   - run `psyche devices revoke <id>` for anything you do not recognise (this also revokes its grants and node authority);
   - re-pair the devices you use.
4. **If vault secrets may be exposed:**
   - `psyche vault lock`;
   - rotate the affected credentials at their services;
   - update them with `psyche vault add`.

   A vault re-key command is planned (docs/05 §15.3, `psyche vault rekey`) and does not exist yet.
5. **Keep evidence.** Run `psyche audit verify`, then `psyche export`, to keep a copy of the audit chain, receipts and grants before you change anything else.

## 7. Credit and contact

Reporters are credited in the advisory and the write-up unless they ask not to be. We do not run a paid bounty. Questions about this process go through the same private channel as reports.
