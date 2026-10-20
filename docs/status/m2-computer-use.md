# M2 computer use: status

Updated 2026-10-19. Makes the Mac helper's computer use (S14, J1–J5) reachable by the agent.

## Works

- **Agent tools** (`apps/gateway/src/compose/computer.ts`, #219): `computer.snapshot` (AX tree, ≤ 400 elements, 40k chars), `computer.act` (by ref with `expect`, AX first), `computer.screenshot` (only after a snapshot of the same app), `apps.list` / `open` / `focus` / `shortcuts_list`, `apps.applescript` (JXA via `language`) behind `apple_script`, `apps.shortcut_run` behind `shortcut_run` (#212). App bundle ids are the targets, so the broker's tiers, fixed caps, `app:` rules and new-source reads apply; risky labels, chords and menu items are `destructive`; output is `untrusted`.
- **Review fixes** (#227): refs must come from a snapshot of the target app and carry the snapshot's label; points, unknown refs and risky labels are `destructive`; per-run helper sessions (Esc no longer blocks a Task); helper-requested approvals consult `broker.decide`; `apps.open` opens `file:` / `mailto:` only.
- **Helper asks** (`tier_ask`, `risky_label`) become a `computer_action` approval bound to the call, offered once; the approved retry gives the helper's 30-minute allowance. Unattended runs queue the card.
- **Sessions**: one per Task (per run for chat turns), named on every `computer.*` call; one drives the computer at a time; `computer.end_session` when the run or Task ends. Esc on the Mac cancels the run.
- **Settings → Computer use** (`compose/computer-settings.ts`): `computerUse.enabled` and `computerUse.apps` write `$PSYCHE_HOME/config/computer-use.json` (0600, atomic; off → `default: "off"`) and layer the tiers over `permissions.policy.apps` in the broker. Both keys need operator.admin and fresh presence. The tools are registered only while computer use is on. Apps the agent uses are listed as **Ask** the first time; the section gained an Ask column.

## Not done / follow-ups

- Screenshots reach the model as base64 JSON (like `browser.screenshot`); image tool-result parts would save context.
- The broker's tier check keys on the tool name, so `computer.act` always needs `interact` at the broker (stricter than a `click` tier for plain clicks); `apps.open` / `focus` likewise. A `ToolCallDescription` field for the action (S05) would make it exact.
- The helper's 30-minute allowances live only in the helper; they are not shown in Settings.
- Subagents can reach executor-side approval cards (the call context has no subagent flag; S02).
- No live runs (no signed helper install with grants on this machine); tests use a fake helper node.
