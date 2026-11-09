---
name: psyche-builder
description: How a builder session works on Psyche from brief to PR. Covers reading the brief and goal, finding the code, making the change, the local verification loop, opening the PR and the report format. Invoke it first in any session the orchestrator started to build, fix or investigate something in this repo.
---

# Building on Psyche

The orchestrator gave you a brief and usually a `/goal`. Your job is one focused PR that meets the "Done means" in the brief, verified locally, with an honest report. The hard rules in `.claude/CLAUDE.md` apply at all times.

## 1. Understand before editing

- Restate the task to yourself in one line. If the brief names files, read them first. Otherwise search: `grep -rn` on the user-visible string or error text is usually the fastest way in.
- Check the domain skills under `.claude/skills/`. Use `psyche-i18n` for any string and `psyche-apple` for Swift, iOS or the Mac helper. Use any skill whose description matches your area.
- Read `learnings.md` next to this file. It holds traps earlier builders hit.
- If the brief is ambiguous or seems wrong once you read the code, say so in your report rather than guessing at something large. Small, obvious choices you just make, and you note them in the report.

## 2. Make the change

- Smallest change that fully solves it. Fix the cause, not the symptom, and say what the cause was.
- Add or update tests that would have caught the bug or prove the feature works. Follow the patterns of the nearest existing test file.
- Keep to the brief's scope. Unrelated problems you notice go in the report under "Noticed", not in the diff.
- Protocol changes: `pnpm protocol:gen`. If you add an enum value, update the Swift helper's exhaustive `switch` sites and the TS `Record<Kind, …>` maps.

## 3. Verify (the loop)

1. Run `bash .claude/scripts/verify.sh`, adding `--swift` if you touched Swift. It runs your new tests and every existing test that imports the code you changed. Those existing tests are the ones builders most often break without noticing.
2. Fix every failure and run it again. Repeat until it passes.
3. Run `pnpm exec biome check --write <touched dirs>` last, after your final edit, then re-run verify.

The Stop hook re-runs verify when you try to finish with changes it hasn't seen pass. If it blocks you, fix what it reports. Never skip, weaken, `.skip` or delete a test to get it passing. If you truly cannot fix a failure after 3 attempts, stop and report it plainly.

UI changes: if the brief asks for screenshots, use the browser preview or simulator as it says. Never run the built Psyche.app.

## 4. Open the PR

- Commit with a clear message ending in the `Co-Authored-By` line from `.claude/CLAUDE.md`.
- Push, then run `gh pr create --draft` with a body in this shape:
  - **What and why:** the cause and the fix, in plain words.
  - **Verification:** the verify.sh summary line and anything else you ran.
  - **Not verified:** what you could not check (real app, device, CI).
  - **Owner checks:** manual steps, if any.
  - **Learnings:** 0–3 one-line, non-obvious things a future builder should know (a trap, a command that works, a file that's easy to miss). Leave it empty if there is nothing new. The `reflect` skill harvests this section into the skills.
  - The 🤖 footer.
- Then `gh pr ready <n>`.

## 5. Report

End your turn with:
- one line on the outcome, with the PR link;
- the cause, the fix, and the verification result;
- "Not verified", "Noticed" and any question for the orchestrator.

No praise or filler. If something failed, say it failed.

When the orchestrator sends review findings, fix them on the same branch, verify, push, and report again in the same shape.
