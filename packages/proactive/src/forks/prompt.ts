/**
 * The branch prompt (docs/design/fork-a-plan-2026.md §2.3): the unattended-run contract, the Night
 * shift paragraph ("Prepare, don't act"), then the fork paragraph. The premise is the owner's text
 * and is not tainted, but it is framed as a hypothesis and placed in a fenced block with its value
 * JSON-quoted (psyche-permissions §3e), so a premise cannot close the fence or read as an
 * instruction.
 */

/** Task titles: the forced-report task is recognised by its prefix (it survives a restart). */
export const BRANCH_TITLE_PREFIX = "Plan: ";
export const FORCED_TITLE_PREFIX = "Plan report: ";

const FENCE_TICKS = /`{3,}/g;

/** One line, bounded, fence-free: a label used in a task title. */
export function plainLabel(text: string, max = 40): string {
  return text.replace(/\s+/g, " ").replace(FENCE_TICKS, "'''").trim().slice(0, max);
}

/** The unattended contract of an automation run, for a fork (nobody is present). */
const UNATTENDED = [
  "[Unattended run of a plan fork.]",
  "Nobody is present to answer questions or approve actions:",
  "- Your final deliverable is the report you file with fork_report, not a plan or a question.",
  "- Any action that needs approval cannot happen in this run; list it as a step for the owner.",
  "- A finished run is not proof that the job succeeded: say what you checked.",
].join("\n");

const PREPARE =
  "Prepare, don't act. Each change is recorded in this plan's branch and does not happen now. Make each change one complete call. Don't plan steps that need an earlier change's result.";

/** The fork paragraph. `quoted` is the premise as a JSON string. */
function forkParagraph(quoted: string): string {
  return [
    "You are working out one option the owner is weighing. Assume, for this plan only, the premise in the block below. It is a hypothesis, not a fact: don't record it anywhere as true.",
    "Find what the option would cost, the dates and deadlines it sets, the people it affects and what it gives up, using the owner's memory, calendar, mail and the web. Cite the tool results you used. When a number isn't in a result, mark it as an estimate.",
    "Fetch only pages that a web search of yours returned. Anything you could not check goes under open questions. Finish by calling fork_report once.",
    "",
    "```json",
    quoted,
    "```",
  ].join("\n");
}

/** The goal of a branch's main task. */
export function buildBranchGoal(input: { label: string; premise: string }): string {
  const quoted = JSON.stringify({
    option: plainLabel(input.label, 80),
    premise: input.premise.replace(FENCE_TICKS, "'''"),
  });
  return [UNATTENDED, "", PREPARE, "", forkParagraph(quoted)].join("\n");
}

/** The goal of the forced-report task: only `fork_report` is registered for it. */
export function buildForcedReportGoal(input: { label: string }): string {
  return [
    UNATTENDED,
    "",
    `The budget for the option ${JSON.stringify(plainLabel(input.label, 80))} is used up.`,
    "File your report now with fork_report, using only what you already found in this conversation. Don't search or call any other tool. Anything you could not finish goes under open questions. Mark every number you did not read in a result as an estimate.",
  ].join("\n");
}
