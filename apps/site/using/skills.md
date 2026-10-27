---
title: Skills
---

# Skills

A skill is a folder of instructions, a `SKILL.md` file, that tells the agent how to do one kind of job well: triaging an inbox, planning a week, writing a research brief. Skills never grant a tool or a permission; everything a skill leads the agent to do still goes through your approvals. Psyche ships twelve skills, and you can install more after reviewing exactly what each one contains and asks for.

## Turn it on

Bundled skills are on from the start. Open Settings → Skills to see them under **Bundled with Psyche**, with your own under **Installed**.

The agent sees a short index of the skills it can use and reads a skill's full text when a request fits it. You don't need to name the skill. A skill whose tools are not available, for example because you have not turned on computer use, is hidden from the index and shows as "Unavailable here".

## What it can do

### Bundled skills

| Skill | What it is for |
| --- | --- |
| `browsing` | Using the agent browser safely: site approvals, Take control, downloads |
| `research-brief` | Research from several sources, with citations |
| `inbox-triage` | Reading new mail, summarizing it and proposing what to do |
| `reply-drafting` | Drafting replies to email and messages for your approval |
| `calendar-planning` | Planning a week, finding slots, proposing events |
| `shopping-compare` | Comparing prices across shops and handing off checkout |
| `travel-hold` | Finding a flight and taking it up to the point of booking |
| `document-filling` | Filling in a PDF form from an email |
| `spreadsheet-analysis` | Summarizing and analyzing spreadsheets |
| `memory-hygiene` | Keeping the memory files tidy |
| `weekly-review` | Summarizing the week against your goals |
| `subscription-audit` | Finding recurring charges and preparing cancellations |

Some of these depend on features that are not reachable yet, such as mail connectors. See [Connectors](/using/connectors).

### Installing a skill

From the app:

1. Open Settings → Skills.
2. Under **Install a skill**, type the path of a skill folder or `.zip` file on the machine that runs the Gateway, and click **Review**.
3. Read the review card (below), then approve or deny.

From the CLI, which also accepts a git URL:

```bash
psyche skills install ~/Downloads/expense-export
psyche skills install https://github.com/someone/skills.git --ref v1.2.0
```

The CLI prints an approval id. You review and approve the skill in the app; it installs only after that. A git source is pinned to an exact commit.

### Managing skills

- Each skill has a status chip: Active, Off, Not approved, Not installed by Psyche, Changed since approval, Invalid, Blocked, Unavailable here or Overridden.
- Turn a skill on or off, or **Remove** it. Removing deletes its files from the Gateway; installing it again goes through the review card.
- **Check for updates** looks for new versions. When one exists, the skill shows "Update available", with "asks for different things" if the update wants other tools or approvals. **Review update** shows the per-file diff. Until you approve, the files you approved earlier keep loading.

From the CLI:

```bash
psyche skills list
psyche skills verify
psyche skills verify --strict
```

`psyche skills verify` exits with code 1 when a skill's files no longer match what you approved, or the skill is invalid or blocked. With `--strict`, it also fails on skills that were never reviewed or whose publisher is unknown.

## What it asks you

Installing or updating a skill opens an "Install skill" card. It is device-only and Allow once only. The card shows:

- **Source** and **Publisher**: Bundled with Psyche, Your own or Unknown publisher.
- Under **Details**: the commit, the content hash, the tool names, the permissions it asks for (for example "Send email" or "Pay for things"), the tools, and the prompt files.
- **Scan findings** from a static scan: pipe-to-shell commands, prerequisites that download and install things, attempts to read credentials, hidden characters, instructions aimed at the agent, and more. "The static scan found nothing to flag." when clean.
- For an update, the diff.
- **SKILL.md (full text)**.

A policy refuses a skill that asks for more than a skill may have, before any card appears. A skill with a high-severity finding installs turned off and cannot be turned on. Text from a third-party skill is treated as untrusted content.

::: info Screenshot placeholder
The "Install skill" review card: Source, Publisher "Unknown publisher", the Details fold open with the content hash and "Asks for: Send email", one Scan findings warning, and the SKILL.md full text below.
:::

## Limits today

- The Settings field takes a folder or `.zip` on the Gateway's machine. To install from git, use `psyche skills install`.
- There is no skill registry or marketplace, and the "Verified publisher" label never appears yet.
- Updates are found only when you click **Check for updates**. Psyche re-checks the hashes of installed files in the background, so a skill changed on disk shows "Changed since approval".
- Running a skill by name as a slash command in the composer is not available; ask for the job in plain words.
- Skills the agent proposes from Ideas stay drafts; you review them like any other install.

## Learn more

- [Approvals and tiers](/security/approvals-and-tiers)
- [Untrusted content](/security/taint)
- [CLI reference](/reference/cli)
- [Bundled skills](https://github.com/devmello/psyche/tree/main/skills)
- [Skills package](https://github.com/devmello/psyche/tree/main/packages/skills)
- [Supply chain in the security design](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#11-supply-chain)
